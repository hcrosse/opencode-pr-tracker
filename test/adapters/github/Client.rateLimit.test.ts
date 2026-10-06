import { describe, expect, test } from "bun:test"

import { Effect, Exit, Logger, Schema } from "effect"
import { TestClock } from "effect/testing"

import type { GitHubApi } from "../../../src/ports/GitHub.ts"
import { memoryStorage } from "../../support/application.ts"
import {
  acmeRef,
  fetchOne,
  httpClient,
  requestsAt,
  runClient,
  type HttpFake,
  type RequestBody,
} from "../../support/github.ts"

const answered = (): Response => Response.json({ data: { pr0: null } })

const forbidden = (body: string, headers: Readonly<Record<string, string>>): Response =>
  new Response(body, { headers, status: 403 })

const secondaryLimit = (): Response => forbidden("You have exceeded a secondary rate limit", {})

describe("GitHub client rate limits", () => {
  test("stops another instance sharing storage while GitHub's retry-after lasts", async () => {
    const storage = memoryStorage()
    const limited = httpClient(() => forbidden("", { "retry-after": "60" }))
    const other = httpClient(answered)

    const first = await runClient({ http: limited, storage }, fetchOne)
    const second = await runClient({ http: other, storage }, fetchOne)

    expect(Exit.findErrorOption(first)).toMatchObject({ value: { diagnostic: "RateLimited" } })
    expect(Exit.findErrorOption(second)).toMatchObject({ value: { diagnostic: "RateLimited" } })
    expect(other.requests).toHaveLength(0)
  })

  test("sends again once a spent budget's reset time has passed", async () => {
    const storage = memoryStorage()

    const limited = httpClient(() =>
      Response.json(
        { errors: [{ type: "RATE_LIMITED" }] },
        { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" } },
      ),
    )

    const next = httpClient(answered)

    const first = await runClient({ http: limited, storage }, fetchOne)
    const second = await runClient({ http: next, storage }, fetchOne)

    expect(Exit.findErrorOption(first)).toMatchObject({ value: { diagnostic: "RateLimited" } })
    expect(Exit.isSuccess(second)).toBe(true)
    expect(next.requests).toHaveLength(1)
  })
})

describe("GitHub client rate limits reported with data", () => {
  test("stops sending after a RATE_LIMITED error that came with data", async () => {
    const http = httpClient(() =>
      Response.json({
        data: { pr0: null },
        errors: [{ message: "slow down", type: "RATE_LIMITED" }],
      }),
    )

    const result = await runClient({ http }, (github: GitHubApi) =>
      Effect.andThen(Effect.flip(fetchOne(github)), Effect.flip(fetchOne(github))),
    )

    expect(result).toMatchObject({ value: { diagnostic: "RateLimited" } })
    expect(http.requests).toHaveLength(1)
  })
})

/** Answers #1, limits #2 for a minute, and gives #3 a limit without a time. */
const byPullRequest = (body: RequestBody): Response => {
  if (body.variables["pr0"] === acmeRef(1).url) return answered()

  return body.variables["pr0"] === acmeRef(2).url
    ? forbidden("", { "retry-after": "60" })
    : secondaryLimit()
}

/**
 * After an unhinted limit has passed, #1 is answered while #2 is limited at the same moment. Returns
 * the requests sent once a later fetch of #1 is done.
 */
const answerDuringLimit =
  (http: HttpFake) =>
  (github: GitHubApi): Effect.Effect<number> =>
    Effect.gen(function* () {
      yield* Effect.exit(github.fetch([acmeRef(3)]))
      yield* TestClock.setTime(60_000)
      yield* Effect.all([github.fetch([acmeRef(1)]), github.fetch([acmeRef(2)])], {
        concurrency: "unbounded",
        mode: "result",
      })
      yield* TestClock.setTime(60_001)
      yield* Effect.exit(github.fetch([acmeRef(1)]))

      return http.requests.length
    }).pipe(Effect.provide(TestClock.layer()))

describe("GitHub client answers during a limit", () => {
  test("keeps a wait recorded while another request was answered", async () => {
    const http = httpClient(byPullRequest)
    const result = await runClient({ http }, answerDuringLimit(http))

    expect(result).toEqual(Exit.succeed(3))
  })
})

describe("GitHub client waits without a time from GitHub", () => {
  test("waits a minute, then two, when GitHub gives no time", async () => {
    const http = httpClient(secondaryLimit)
    const times = [0, 59_999, 60_000, 179_999, 180_000]

    const result = await runClient({ http }, requestsAt(http, times))

    expect(result).toEqual(Exit.succeed([1, 1, 2, 2, 3]))
  })

  test("does not pause after a server error", async () => {
    const http = httpClient(() => new Response("bad gateway", { status: 502 }))

    const result = await runClient({ http }, (github: GitHubApi) =>
      Effect.andThen(fetchOne(github), fetchOne(github)),
    )

    expect(Exit.map(result, (results) => results.get(acmeRef(1).url))).toMatchObject({
      value: { diagnostic: "GitHubUnavailable" },
    })
    expect(http.requests).toHaveLength(2)
  })
})

const LoggedHeaders = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))

const Line = Schema.fromJsonString(Schema.Struct({ level: Schema.String }))

const Warning = Schema.fromJsonString(
  Schema.Struct({
    annotations: Schema.Struct({
      body: Schema.String,
      headers: LoggedHeaders,
      status: Schema.Number,
    }),
  }),
)

/** The warnings among log lines that Effect's JSON logger wrote. */
const warningsIn = (lines: readonly string[]): readonly (typeof Warning.Type)[] =>
  lines.flatMap((line: string) =>
    Schema.decodeUnknownSync(Line)(line).level === "WARN"
      ? [Schema.decodeUnknownSync(Warning)(line)]
      : [],
  )

/** Fetches once, returning each log line as Effect's JSON logger writes it. */
const loggedFetch = (github: GitHubApi): Effect.Effect<readonly string[]> =>
  Effect.suspend(() => {
    const lines: string[] = []

    const capture = Logger.map(Logger.formatJson, (line: string) => {
      lines.push(line)
    })

    return Effect.exit(fetchOne(github)).pipe(
      Effect.provide(Logger.layer([capture])),
      Effect.as(lines),
    )
  })

describe("GitHub client failure logs", () => {
  test("logs a failed request's status and rate-limit headers without the token", async () => {
    const http = httpClient(() =>
      forbidden("API rate limit exceeded", {
        "retry-after": "60",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1700000000",
      }),
    )

    const result = await runClient({ http }, loggedFetch)
    const lines = Exit.isSuccess(result) ? result.value : []

    expect(warningsIn(lines)).toEqual([
      {
        annotations: {
          body: "API rate limit exceeded",
          headers: {
            "retry-after": "60",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1700000000",
          },
          status: 403,
        },
      },
    ])
    expect(lines.join("\n")).not.toContain("recorded-token")
  })
})

describe("GitHub client logs of answers it cannot use", () => {
  test.each([
    ["a body that is not JSON", (): Response => new Response("<html>"), "<html>"],
    [
      "an envelope without data",
      (): Response => Response.json({ errors: [{ message: "timeout" }] }),
      '{"errors":[{"message":"timeout"}]}',
    ],
  ] as const)("logs the body of %s", async (_name, respond, body) => {
    const result = await runClient({ http: httpClient(respond) }, loggedFetch)
    const lines = Exit.isSuccess(result) ? result.value : []

    expect(warningsIn(lines)).toEqual([{ annotations: { body, headers: {}, status: 200 } }])
  })
})

describe("GitHub client logs of bodies it cannot read", () => {
  test("logs a 2xx response whose body fails to arrive", async () => {
    const broken = new ReadableStream({
      start: (controller: ReadableStreamDefaultController): void => {
        controller.error(new Error("connection reset"))
      },
    })

    const http = httpClient(() => new Response(broken))
    const result = await runClient({ http }, loggedFetch)
    const lines = Exit.isSuccess(result) ? result.value : []

    expect(warningsIn(lines)).toMatchObject([{ annotations: { headers: {}, status: 200 } }])
  })
})
