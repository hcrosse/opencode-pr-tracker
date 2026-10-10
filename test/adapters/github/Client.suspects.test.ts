import { describe, expect, test } from "bun:test"

import { Effect, Exit } from "effect"

import type { PullRequestRef } from "../../../src/domain/PullRequest.ts"
import { ItemResult, maximumBatch, type GitHubApi } from "../../../src/ports/GitHub.ts"
import {
  acmeRef,
  httpClient,
  recordedNode,
  recordedPullRequest,
  runClient,
  tracker127,
  type HttpFake,
  type RequestBody,
} from "../../support/github.ts"
import { found, requested } from "../../support/lookup.ts"

const numbers = (count: number): number[] =>
  Array.from({ length: count }, (_, index: number) => index + 1)

/** GitHub as it times out on any query that includes one of `stuck`, reporting the rest. */
function timingOutOn(stuck: readonly number[]): HttpFake {
  const urls = new Set(stuck.map((number: number) => acmeRef(number).url))

  return httpClient((body: RequestBody) =>
    [...requested(body).values()].some((url: string) => urls.has(url))
      ? new Response("gateway timeout", { status: 504 })
      : Response.json({
          data: Object.fromEntries(
            [...requested(body).keys()].map((key: string) => [key, found(recordedPullRequest)]),
          ),
        }),
  )
}

/** The pull request numbers in each request after the first `from`. */
const sentSince = (http: HttpFake, from: number): number[][] =>
  http.requests
    .slice(from)
    .map((request: RequestBody) =>
      [...requested(request).values()].map((url: string) => Number(url.split("/").at(-1))),
    )

const failedOf = (results: ReadonlyMap<string, ItemResult>): number[] =>
  [...results].flatMap(([url, result]: readonly [string, ItemResult]) =>
    ItemResult.$is("Failed")(result) ? [Number(url.split("/").at(-1))] : [],
  )

interface Round {
  readonly sent: readonly (readonly number[])[]
  readonly failed: readonly number[]
}

/** Fetches `refs` `times` times, with what each fetch sent and which pull requests failed. */
const rounds =
  (http: HttpFake, fetched: readonly PullRequestRef[], times: number) =>
  (github: GitHubApi): Effect.Effect<Round[], unknown> =>
    Effect.forEach(numbers(times), () =>
      Effect.gen(function* () {
        const from = http.requests.length
        const results = yield* github.fetch(fetched)

        return { failed: failedOf(results), sent: sentSince(http, from) }
      }),
    )

const refs = (count: number): PullRequestRef[] =>
  numbers(count).map((number: number) => acmeRef(number))

describe("GitHub client with one pull request that always times out", () => {
  test("reports every other pull request while one keeps timing out", async () => {
    const http = timingOutOn([3])
    const count = maximumBatch + 5
    const exit = await runClient({ http }, rounds(http, refs(count), 4))
    const result = Exit.isSuccess(exit) ? exit.value : []
    const settled = result.map((round: Round) => round.sent).at(-1) ?? []

    // #3's batch times out, then #1 and #2 are reported alone, then the rest of its batch.
    expect(result.map((round: Round) => round.failed.length)).toEqual([
      count,
      maximumBatch - 2,
      1,
      1,
    ])
    expect(result.map((round: Round) => round.failed).at(-1)).toEqual([3])
    // Once reported, #3's batchmates are batched again; only #3 is sent alone, last.
    expect(settled.at(-1)).toEqual([3])
    expect(settled.slice(0, -1).every((request) => request.length > 1)).toBe(true)
    expect(settled.flat().toSorted((left, right) => left - right)).toEqual(numbers(count))
  })
})

describe("GitHub client suspects", () => {
  test("sends each suspect that keeps timing out in turn", async () => {
    const http = timingOutOn([1, 2])
    const result = await runClient({ http }, rounds(http, refs(2), 4))

    expect(Exit.map(result, (all: readonly Round[]) => all.map((round) => round.sent))).toEqual(
      Exit.succeed([[[1, 2]], [[1]], [[2]], [[1]]]),
    )
  })
})

/** The aliases a batch request asks for, or `"page"` for a page of checks. */
const sent = (request: RequestBody): readonly string[] | "page" =>
  "cursor" in request.variables ? "page" : [...requested(request).keys()]

describe("GitHub client on a page of checks that times out", () => {
  test("sends the pull request alone after the others next time", async () => {
    const paged = recordedNode("paginated", "pr1")

    const http = httpClient((body: RequestBody) =>
      "cursor" in body.variables
        ? new Response("gateway timeout", { status: 504 })
        : Response.json({
            data: Object.fromEntries(
              [...requested(body)].map(([key, url]: readonly [string, string]) => [
                key,
                url === tracker127.url ? found(paged) : null,
              ]),
            ),
          }),
    )

    const result = await runClient({ http }, (github: GitHubApi) =>
      Effect.andThen(
        github.fetch([tracker127, acmeRef(2)]),
        github.fetch([tracker127, acmeRef(2)]),
      ),
    )

    expect(Exit.map(result, (results) => results.get(tracker127.url))).toEqual(
      Exit.succeed(ItemResult.Failed({ charged: true, diagnostic: "GitHubUnavailable" })),
    )
    // A first batch with its page of checks, then #2, then #127 alone with its page.
    expect(http.requests.map((request: RequestBody) => sent(request))).toEqual([
      ["pr0", "pr1"],
      "page",
      ["pr0"],
      ["pr0"],
      "page",
    ])
  })
})

describe("GitHub client suspects GitHub answers for", () => {
  test("batches a suspect again once GitHub reports it missing", async () => {
    const http = httpClient((body: RequestBody, count: number) =>
      count === 1
        ? new Response("gateway timeout", { status: 504 })
        : Response.json({
            data: Object.fromEntries([...requested(body).keys()].map((key) => [key, null])),
          }),
    )

    const result = await runClient({ http }, rounds(http, refs(2), 3))

    expect(Exit.map(result, (all: readonly Round[]) => all.map((round) => round.sent))).toEqual(
      Exit.succeed([[[1, 2]], [[1], [2]], [[1, 2]]]),
    )
  })
})
