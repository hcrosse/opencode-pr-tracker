import { Effect, Exit } from "effect"
import { describe, expect, test } from "vitest"

import { ItemResult, maximumBatch, type GitHubApi } from "../../../src/ports/GitHub.ts"
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

const notFound = ItemResult.Failed({ charged: false, diagnostic: "NotFound" })

const invalid = ItemResult.Failed({ charged: false, diagnostic: "InvalidResponse" })

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
    [
      "a 2xx JSON answer cut off",
      (): Response =>
        new Response('{"data":{"pr0":', {
          headers: { "content-type": "application/json; charset=utf-8" },
          status: 200,
        }),
    ],
    ["an empty 2xx answer", (): Response => new Response("", { status: 200 })],
    ["a 2xx answer that could not be read", unreadable],
  ])("stops the fetch after %s, charging every pull request", async (_name, timedOut) => {
    const http = httpClient(firstAnswer(timedOut))
    const result = await runClient({ http }, fetchTwice)

    expect(result).toEqual(
      Exit.succeed([
        ItemResult.Failed({ charged: true, diagnostic: "GitHubUnavailable" }),
        ItemResult.Failed({ charged: true, diagnostic: "GitHubUnavailable" }),
      ]),
    )
    // The last pull request's batch was not sent, and nothing waits before the next fetch.
    expect(sizesOf(http.requests)).toEqual([maximumBatch, 1])
  })
})

type NonTimeoutFailure = readonly [
  name: string,
  answer: () => Response | "unreachable",
  expected: ItemResult,
]

const nonTimeoutFailures: readonly NonTimeoutFailure[] = [
  [
    "a 500",
    (): Response => new Response("", { status: 500 }),
    ItemResult.Failed({ charged: true, diagnostic: "GitHubUnavailable" }),
  ],
  [
    "a 503",
    (): Response => new Response("", { status: 503 }),
    ItemResult.Failed({ charged: true, diagnostic: "GitHubUnavailable" }),
  ],
  ["JSON that is not a GraphQL answer", (): Response => Response.json(["not", "an"]), invalid],
  ["a JSON object without data or errors", (): Response => Response.json({}), invalid],
  [
    "a JSON message without data or errors",
    (): Response => Response.json({ message: "Something went wrong" }),
    invalid,
  ],
  [
    "an HTML page with quotes and unclosed brackets",
    (): Response =>
      new Response('<html><body><p class="x">Proxy error: {"retry" [</p></body></html>', {
        headers: { "content-type": "text/html" },
        status: 200,
      }),
    invalid,
  ],
  [
    "a GraphQL error without data",
    (): Response => Response.json({ data: null, errors: [{ message: "Something went wrong" }] }),
    ItemResult.Failed({ charged: false, diagnostic: "GitHubUnavailable" }),
  ],
  [
    "a request that never reached GitHub",
    (): "unreachable" => "unreachable",
    ItemResult.Failed({ charged: false, diagnostic: "GitHubUnavailable" }),
  ],
]

describe("GitHub client failures that are not timeouts", () => {
  test.each(nonTimeoutFailures)(
    "sends every batch after %s",
    async (_name: string, answer: () => Response | "unreachable", expected: ItemResult) => {
      const http = httpClient(firstAnswer(answer))
      const result = await runClient({ http }, fetchTwice)

      expect(result).toEqual(Exit.succeed([expected, notFound]))
      expect(sizesOf(http.requests)).toEqual([maximumBatch, 1, 1])
    },
  )
})
