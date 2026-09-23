import { describe, expect, test } from "bun:test"

import { Effect, Exit, Layer, Result } from "effect"

import { layer as clientLayer } from "../../../src/adapters/github/Client.ts"
import { parsePullRequestUrl, type PullRequestRef } from "../../../src/domain/PullRequest.ts"
import { GitHub, type GitHubApi, type ItemResult } from "../../../src/ports/GitHub.ts"
import {
  exitWith,
  fixedCommands,
  fixedToken,
  httpClient,
  output,
  recordedNode,
  type CommandsFake,
  type HttpFake,
  type RequestBody,
  type TokenFake,
} from "../../support/github.ts"

const ref = (number: number): PullRequestRef =>
  Result.getOrThrow(parsePullRequestUrl(`github.com/acme/api/pull/${String(number)}`))

/** hcrosse/opencode-pr-tracker#127, as recorded in the standalone fixture. */
const recordedPullRequest = recordedNode("standalone", "pr0")

const tracker127 = Result.getOrThrow(
  parsePullRequestUrl("github.com/hcrosse/opencode-pr-tracker/pull/127"),
)

interface Setup {
  readonly http: HttpFake
  readonly commands?: CommandsFake
  readonly token?: TokenFake
}

async function run<A, E>(
  setup: Setup,
  use: (github: GitHubApi) => Effect.Effect<A, E>,
): Promise<Exit.Exit<A, E>> {
  const token = setup.token ?? fixedToken()
  const commands = setup.commands ?? fixedCommands({})
  const layer = clientLayer.pipe(Layer.provide([setup.http.layer, token.layer, commands.layer]))
  const result = await Effect.runPromise(Effect.exit(GitHub.use(use).pipe(Effect.provide(layer))))

  return result
}

const fetchOne = (github: GitHubApi): Effect.Effect<ReadonlyMap<string, ItemResult>, unknown> =>
  github.fetch([ref(1)])

const nulls = (keys: readonly string[]): Record<string, null> =>
  Object.fromEntries(keys.map((key: string) => [key, null]))

describe("GitHub client authentication", () => {
  test("refreshes the token once after a 401 and retries", async () => {
    const token = fixedToken()

    const http = httpClient((_body, count: number) =>
      count === 1 ? new Response("", { status: 401 }) : Response.json({ data: { pr0: null } }),
    )

    const result = await run({ http, token }, fetchOne)

    expect(Exit.isSuccess(result)).toBe(true)
    expect(token.invalidations()).toBe(1)
    expect(http.requests).toHaveLength(2)
  })

  test("reports authentication required when the refreshed token is also rejected", async () => {
    const http = httpClient(() => new Response("", { status: 401 }))
    const result = await run({ http }, fetchOne)

    expect(Exit.findErrorOption(result)).toMatchObject({
      value: { diagnostic: "AuthenticationRequired" },
    })
    expect(http.requests).toHaveLength(2)
  })
})

describe("GitHub client failures of a whole request", () => {
  test.each([
    [
      "a server error",
      (): Response => new Response("bad gateway", { status: 502 }),
      "GitHubUnavailable",
    ],
    [
      "a body that is not JSON",
      (): Response => new Response("<html>", { status: 200 }),
      "InvalidResponse",
    ],
    [
      "errors without data, as when rate limited",
      (): Response => Response.json({ errors: [{ type: "RATE_LIMITED" }] }),
      "GitHubUnavailable",
    ],
  ] as const)("reports %s", async (_name, respond, diagnostic) => {
    const result = await run({ http: httpClient(respond) }, fetchOne)

    expect(Exit.findErrorOption(result)).toMatchObject({ value: { diagnostic } })
  })
})

describe("GitHub client failures of one pull request", () => {
  test("reports a GraphQL error on one alias for that pull request only", async () => {
    const http = httpClient(() =>
      Response.json({
        data: { pr0: recordedPullRequest, pr1: null },
        errors: [{ path: ["pr1"], type: "FORBIDDEN" }],
      }),
    )

    const result = await run({ http }, (github: GitHubApi) => github.fetch([tracker127, ref(2)]))
    const results = Exit.isSuccess(result) ? [...result.value.values()] : []

    expect(results.map((item: ItemResult) => item._tag)).toEqual(["Reported", "Failed"])
    expect(results[1]).toEqual({ _tag: "Failed", diagnostic: "NotFound" })
  })
})

describe("GitHub client failures in a pull request's data", () => {
  test("reports a broken page of checks for that pull request only", async () => {
    const paged = recordedNode("paginated", "pr1")

    const http = httpClient((body: RequestBody) =>
      "pr0" in body.variables
        ? Response.json({ data: { pr0: paged } })
        : Response.json({ data: { resource: null } }),
    )

    const result = await run({ http }, (github: GitHubApi) => github.fetch([tracker127]))

    expect(Exit.map(result, (results) => results.get(tracker127.url))).toEqual(
      Exit.succeed({ _tag: "Failed", diagnostic: "InvalidResponse" }),
    )
    expect(http.requests).toHaveLength(2)
  })

  test("reports an unexpected pull request shape as an invalid response", async () => {
    const http = httpClient(() =>
      Response.json({ data: { pr0: { __typename: "PullRequest", url: 7 } } }),
    )

    const result = await run({ http }, fetchOne)

    expect(Exit.map(result, (results) => results.get(ref(1).url))).toEqual(
      Exit.succeed({ _tag: "Failed", diagnostic: "InvalidResponse" }),
    )
  })
})

describe("GitHub client batching", () => {
  test("fetches each pull request once, at most 20 per request", async () => {
    const http = httpClient((body) => Response.json({ data: nulls(Object.keys(body.variables)) }))

    const refs = [
      ...Array.from({ length: 25 }, (_, index: number) => ref(index + 1)),
      ref(3),
      ref(7),
    ]

    const result = await run({ http }, (github: GitHubApi) => github.fetch(refs))

    expect(http.requests.map((request) => Object.keys(request.variables).length)).toEqual([20, 5])
    expect(Exit.map(result, (results) => results.size)).toEqual(Exit.succeed(25))
  })
})

describe("GitHub client batch failures", () => {
  test("keeps the results of batches that succeeded when another batch fails", async () => {
    const http = httpClient((body, count: number) =>
      count === 1
        ? Response.json({ data: nulls(Object.keys(body.variables)) })
        : new Response("", { status: 502 }),
    )

    const refs = Array.from({ length: 21 }, (_, index: number) => ref(index + 1))

    const result = await run({ http }, (github: GitHubApi) => github.fetch(refs))

    // The first batch reported #1 missing; the second batch, with #21, failed as a whole.
    expect(
      Exit.map(result, (results) => [results.get(ref(1).url), results.get(ref(21).url)]),
    ).toEqual(
      Exit.succeed([
        { _tag: "Failed", diagnostic: "NotFound" },
        { _tag: "Failed", diagnostic: "GitHubUnavailable" },
      ]),
    )
  })

  test("fails the whole request when every batch fails", async () => {
    const http = httpClient(() => new Response("", { status: 502 }))
    const refs = Array.from({ length: 21 }, (_, index: number) => ref(index + 1))

    const result = await run({ http }, (github: GitHubApi) => github.fetch(refs))

    expect(Exit.isFailure(result)).toBe(true)
  })
})

describe("GitHub client batching of nothing", () => {
  test("sends nothing for no pull requests", async () => {
    const http = httpClient(() => Response.json({ data: {} }))
    const result = await run({ http }, (github: GitHubApi) => github.fetch([]))

    expect(Exit.map(result, (results) => results.size)).toEqual(Exit.succeed(0))
    expect(http.requests).toHaveLength(0)
  })
})

const lookup = (github: GitHubApi): Effect.Effect<PullRequestRef, unknown> =>
  github.pullRequestInRepository("/work", 7)

describe("GitHub client repository lookup", () => {
  const view = "gh repo view --json url"
  const http = httpClient(() => Response.json({ data: {} }))

  test("resolves a number in the checked-out repository", async () => {
    const commands = fixedCommands({ [view]: output('{"url":"https://github.com/Acme/API"}\n') })
    const result = await run({ commands, http }, lookup)

    expect(Exit.map(result, (found) => found.url)).toEqual(
      Exit.succeed("https://github.com/acme/api/pull/7"),
    )
  })

  test.each([
    [
      "the directory is not a GitHub repository",
      { [view]: exitWith(1, "not a git repository") },
      { _tag: "RepositoryUnavailable" },
    ],
    [
      "gh prints something unexpected",
      { [view]: output("not json") },
      { _tag: "RepositoryUnavailable" },
    ],
    ["gh is not installed", {}, { _tag: "GitHubFailure", diagnostic: "GitHubCliMissing" }],
  ] as const)("fails when %s", async (_name, outcomes, expected) => {
    const result = await run({ commands: fixedCommands(outcomes), http }, lookup)

    expect(Exit.findErrorOption(result)).toMatchObject({ value: expected })
  })
})
