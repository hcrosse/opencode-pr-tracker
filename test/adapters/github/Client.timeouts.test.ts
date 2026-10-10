import { describe, expect, test } from "bun:test"

import { Effect, Exit } from "effect"

import { maximumBatch, type GitHubApi, type ItemResult } from "../../../src/ports/GitHub.ts"
import {
  acmeRef,
  httpClient,
  runClient,
  type RequestBody,
  type Responder,
} from "../../support/github.ts"
import { requested } from "../../support/lookup.ts"

const answered = (body: RequestBody): Response =>
  Response.json({
    data: Object.fromEntries([...requested(body).keys()].map((key: string) => [key, null])),
  })

/** One more pull request than fits in a batch. */
const refs = Array.from({ length: maximumBatch + 1 }, (_, index: number) => acmeRef(index + 1))

const [first, last] = [acmeRef(1), acmeRef(maximumBatch + 1)]

const unavailable = (charged: boolean): ItemResult => ({
  _tag: "Failed",
  charged,
  diagnostic: "GitHubUnavailable",
})

const notFound: ItemResult = { _tag: "Failed", charged: false, diagnostic: "NotFound" }

/** Answers the first request with `first` and every later one as GitHub would. */
const firstAnswer =
  (answer: () => Response | "unreachable"): Responder =>
  (body: RequestBody, count: number) =>
    count === 1 ? answer() : answered(body)

/** Fetches `refs`, then one more, returning the first fetch's results for its first and last. */
const fetchTwice = (github: GitHubApi): Effect.Effect<readonly unknown[], unknown> =>
  Effect.map(
    Effect.tap(github.fetch(refs), github.fetch([acmeRef(maximumBatch + 2)])),
    (results) => [results.get(first.url), results.get(last.url)],
  )

const sizesOf = (requests: readonly RequestBody[]): number[] =>
  requests.map((request: RequestBody) => requested(request).size)

const unreadable = (): Response =>
  new Response(
    new ReadableStream({
      start: (controller: ReadableStreamDefaultController) => {
        controller.error(new Error("connection reset"))
      },
    }),
    { status: 200 },
  )

describe("GitHub client timeouts", () => {
  test.each([
    ["a 502", (): Response => new Response("bad gateway", { status: 502 })],
    ["a 504", (): Response => new Response("gateway timeout", { status: 504 })],
    ["a 2xx answer cut off", (): Response => new Response('{"data":{"pr0":', { status: 200 })],
    ["a 2xx answer that could not be read", unreadable],
  ])("stops the fetch after %s, charging every pull request", async (_name, timedOut) => {
    const http = httpClient(firstAnswer(timedOut))
    const result = await runClient({ http }, fetchTwice)

    expect(result).toEqual(Exit.succeed([unavailable(true), unavailable(true)]))
    // The last pull request's batch was not sent, and nothing waits before the next fetch.
    expect(sizesOf(http.requests)).toEqual([maximumBatch, 1])
  })
})

describe("GitHub client failures that are not timeouts", () => {
  test.each([
    ["a 500", (): Response => new Response("", { status: 500 }), unavailable(true)],
    ["a 503", (): Response => new Response("", { status: 503 }), unavailable(true)],
    [
      "JSON that is not a GraphQL answer",
      (): Response => Response.json(["not", "an", "answer"]),
      { _tag: "Failed", charged: false, diagnostic: "InvalidResponse" } satisfies ItemResult,
    ],
    ["a request that never reached GitHub", (): "unreachable" => "unreachable", unavailable(false)],
  ])("sends every batch after %s", async (_name, answer, expected: ItemResult) => {
    const http = httpClient(firstAnswer(answer))
    const result = await runClient({ http }, fetchTwice)

    expect(result).toEqual(Exit.succeed([expected, notFound]))
    expect(sizesOf(http.requests)).toEqual([maximumBatch, 1, 1])
  })
})
