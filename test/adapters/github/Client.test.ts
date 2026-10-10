import { describe, expect, test } from "bun:test"

import { Effect, Option, Result } from "effect"

import { defaultPageSize } from "../../../src/adapters/github/Query.ts"
import { parsePullRequestUrl, type PullRequestRef } from "../../../src/domain/PullRequest.ts"
import type { Review } from "../../../src/domain/Review.ts"
import { PullRequestState } from "../../../src/domain/Snapshot.ts"
import { Membership } from "../../../src/domain/StackLayout.ts"
import { ItemResult, type GitHubApi, type Report } from "../../../src/ports/GitHub.ts"
import {
  fixture,
  replay,
  runClient,
  trackerRef,
  type HttpFake,
  type RequestBody,
} from "../../support/github.ts"

const ref = (url: string): PullRequestRef => Result.getOrThrow(parsePullRequestUrl(url))

const kubernetes = (number: number): PullRequestRef =>
  ref(`github.com/kubernetes/kubernetes/pull/${String(number)}`)

/** Effect-TS/effect#8431, in a repository whose canonical name has capitals. */
const effect8431 = ref("https://github.com/Effect-TS/effect/pull/8431")

/** The pull requests recorded together in the `standalone` fixture. */
const standalone = [
  trackerRef(127),
  trackerRef(120),
  trackerRef(93),
  ref("github.com/anomalyco/opencode/pull/50760"),
  trackerRef(999999),
]

async function fetch(
  http: HttpFake,
  refs: readonly PullRequestRef[],
  pageSize = defaultPageSize,
): Promise<ReadonlyMap<string, ItemResult>> {
  const exit = await runClient({ http, pageSize }, (github: GitHubApi) => github.fetch(refs))
  const results = await Effect.runPromise(exit)

  return results
}

function reportOf(
  results: ReadonlyMap<string, ItemResult>,
  pullRequest: PullRequestRef,
): Option.Option<Report> {
  return Option.flatMap(Option.fromNullishOr(results.get(pullRequest.url)), (result: ItemResult) =>
    ItemResult.$is("Reported")(result) ? Option.some(result.report) : Option.none(),
  )
}

const stateOf = (
  results: ReadonlyMap<string, ItemResult>,
  pullRequest: PullRequestRef,
): Option.Option<PullRequestState> =>
  Option.map(reportOf(results, pullRequest), (report: Report) => report.snapshot.state)

const isOpen = (state: PullRequestState): boolean =>
  PullRequestState.match(state, {
    Open: () => true,
    Merged: () => false,
    Closed: () => false,
  })

function expectOpenState(
  results: ReadonlyMap<string, ItemResult>,
  pullRequest: PullRequestRef,
  expected: Option.Option<Partial<PullRequestState>>,
): void {
  const state = stateOf(results, pullRequest)

  expect(state).toMatchObject(expected)
  expect(Option.exists(state, isOpen)).toBe(true)
}

type Ci = "passed" | "pending" | "failed" | "none"

const open = (ci: Ci, draft: boolean, behind: boolean): Option.Option<Partial<PullRequestState>> =>
  Option.some({ behind, ci, draft, mergeability: "mergeable" })

const reviewOf = (
  results: ReadonlyMap<string, ItemResult>,
  pullRequest: PullRequestRef,
): Option.Option<Review> =>
  Option.flatMap(stateOf(results, pullRequest), (state: PullRequestState) =>
    PullRequestState.match(state, {
      Open: ({ review }) => Option.some(review),
      Merged: () => Option.none(),
      Closed: () => Option.none(),
    }),
  )

const threads = (unreplied: number, replied: number, fetched: number): Option.Option<Review> =>
  Option.some({
    decision: "none",
    threads: { complete: true, fetched, replied, unknown: 0, unreplied },
  })

describe("GitHub client on a recorded Stack", () => {
  test("reads a merged Stack and its members in order", async () => {
    const results = await fetch(replay(fixture("stack")), [trackerRef(78), trackerRef(79)])

    for (const member of [trackerRef(78), trackerRef(79)]) {
      expect(stateOf(results, member)).toEqual(Option.some(PullRequestState.cases.Merged.make({})))

      const membership = Option.flatMap(
        reportOf(results, member),
        (report: Report) => report.membership,
      )

      const members = Option.flatMap(membership, (found) =>
        Membership.match(found, {
          Stack: ({ members: stackMembers }) => Option.some(stackMembers),
          Standalone: () => Option.none(),
        }),
      )

      expect(members).toEqual(Option.some([trackerRef(78), trackerRef(79)]))

      expect(
        Option.map(reportOf(results, member), (report: Report) => report.nonOpenMembers),
      ).toEqual(Option.some([trackerRef(78).url, trackerRef(79).url]))
    }
  })
})

describe("GitHub client on recorded standalone pull requests", () => {
  test("reads open, behind, conflicting, closed and missing pull requests", async () => {
    const results = await fetch(replay(fixture("standalone")), standalone)

    expectOpenState(results, trackerRef(127), open("passed", true, true))
    expectOpenState(results, trackerRef(120), open("passed", true, true))
    expect(stateOf(results, trackerRef(93))).toEqual(
      Option.some(PullRequestState.cases.Closed.make({})),
    )
    expectOpenState(
      results,
      ref("github.com/anomalyco/opencode/pull/50760"),
      Option.some({ behind: false, ci: "passed", mergeability: "conflicting" }),
    )
    expect(results.get(trackerRef(999999).url)).toEqual(
      ItemResult.Failed({ charged: false, diagnostic: "NotFound" }),
    )
  })

  test("reads review threads, counting unresolved ones by who answered last", async () => {
    const results = await fetch(replay(fixture("standalone")), standalone)

    expect(reviewOf(results, trackerRef(127))).toEqual(threads(2, 0, 2))
    expect(reviewOf(results, trackerRef(120))).toEqual(threads(0, 0, 2))
    expect(reviewOf(results, ref("github.com/anomalyco/opencode/pull/50760"))).toEqual(
      threads(1, 1, 2),
    )
  })

  test("classifies commit statuses", async () => {
    const results = await fetch(replay(fixture("status-contexts")), [
      kubernetes(142875),
      kubernetes(142334),
    ])

    expect(stateOf(results, kubernetes(142875))).toMatchObject(Option.some({ ci: "failed" }))
    expect(stateOf(results, kubernetes(142334))).toMatchObject(Option.some({ ci: "pending" }))
  })
})

const batchLookup =
  "pr0: repository(owner: $pr0_owner, name: $pr0_name) { pullRequest(number: $pr0_number)"

const pageLookup = "repository(owner: $owner, name: $name) { pullRequest(number: $number)"

describe("GitHub client on a recorded repository named with capitals", () => {
  test("asks for it by lowercase owner, name and number, and reports it", async () => {
    const http = replay(fixture("mixed-case"))
    const results = await fetch(http, [effect8431])

    expect(Option.exists(stateOf(results, effect8431), isOpen)).toBe(true)
    expect(http.requests.map((request: RequestBody) => request.variables)).toEqual([
      { pr0_name: "effect", pr0_number: 8431, pr0_owner: "effect-ts" },
    ])
    expect(
      http.requests.map((request: RequestBody) => request.query.includes(batchLookup)),
    ).toEqual([true])
    expect(http.requests.some((request: RequestBody) => request.query.includes("resource("))).toBe(
      false,
    )
  })
})

describe("GitHub client on recorded pages of checks", () => {
  test("follows every page of checks, and paging does not change the result", async () => {
    const http = replay(fixture("paginated"))
    // The pages were recorded 5 checks at a time.
    const paged = await fetch(http, [kubernetes(142865), trackerRef(127)], 5)
    const unpaged = await fetch(replay(fixture("standalone")), standalone)
    const pages = http.requests.filter((request: RequestBody) => "cursor" in request.variables)

    expect(http.requests).toHaveLength(fixture("paginated").length)
    expect(pages.length).toBeGreaterThan(0)
    expect(pages.every((request: RequestBody) => request.query.includes(pageLookup))).toBe(true)
    expect(http.requests.some((request: RequestBody) => request.query.includes("resource("))).toBe(
      false,
    )
    expect(stateOf(paged, kubernetes(142865))).toMatchObject(Option.some({ ci: "failed" }))
    expect(reportOf(paged, trackerRef(127))).toEqual(reportOf(unpaged, trackerRef(127)))
  })
})
