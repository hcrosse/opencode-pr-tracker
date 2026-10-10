import { describe, expect, test } from "bun:test"

import { Effect, Option, Result } from "effect"

import { parsePullRequestUrl, type PullRequestRef } from "../../../src/domain/PullRequest.ts"
import type { Review } from "../../../src/domain/Review.ts"
import type { PullRequestState } from "../../../src/domain/Snapshot.ts"
import type { GitHubApi, ItemResult, Report } from "../../../src/ports/GitHub.ts"
import { fixture, replay, runClient, trackerRef, type HttpFake } from "../../support/github.ts"

const ref = (url: string): PullRequestRef => Result.getOrThrow(parsePullRequestUrl(url))

const kubernetes = (number: number): PullRequestRef =>
  ref(`github.com/kubernetes/kubernetes/pull/${String(number)}`)

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
): Promise<ReadonlyMap<string, ItemResult>> {
  const exit = await runClient({ http }, (github: GitHubApi) => github.fetch(refs))
  const results = await Effect.runPromise(exit)

  return results
}

function reportOf(
  results: ReadonlyMap<string, ItemResult>,
  pullRequest: PullRequestRef,
): Option.Option<Report> {
  return Option.flatMap(Option.fromNullishOr(results.get(pullRequest.url)), (result: ItemResult) =>
    result._tag === "Reported" ? Option.some(result.report) : Option.none(),
  )
}

const stateOf = (
  results: ReadonlyMap<string, ItemResult>,
  pullRequest: PullRequestRef,
): Option.Option<PullRequestState> =>
  Option.map(reportOf(results, pullRequest), (report: Report) => report.snapshot.state)

type Ci = "passed" | "pending" | "failed" | "none"

const open = (ci: Ci, draft: boolean, behind: boolean): Option.Option<Partial<PullRequestState>> =>
  Option.some({ _tag: "Open", behind, ci, draft, mergeability: "mergeable" })

const reviewOf = (
  results: ReadonlyMap<string, ItemResult>,
  pullRequest: PullRequestRef,
): Option.Option<Review> =>
  Option.flatMap(stateOf(results, pullRequest), (state: PullRequestState) =>
    state._tag === "Open" ? Option.some(state.review) : Option.none(),
  )

const threads = (unreplied: number, replied: number, fetched: number): Option.Option<Review> =>
  Option.some({ decision: "none", threads: { complete: true, fetched, replied, unreplied } })

describe("GitHub client on a recorded Stack", () => {
  test("reads a merged Stack and its members in order", async () => {
    const results = await fetch(replay(fixture("stack")), [trackerRef(78), trackerRef(79)])

    for (const member of [trackerRef(78), trackerRef(79)]) {
      expect(stateOf(results, member)).toEqual(Option.some({ _tag: "Merged" }))
      expect(
        Option.flatMap(reportOf(results, member), (report: Report) => report.membership),
      ).toMatchObject(Option.some({ _tag: "Stack", members: [trackerRef(78), trackerRef(79)] }))
      expect(
        Option.map(reportOf(results, member), (report: Report) => report.nonOpenMembers),
      ).toEqual(Option.some([trackerRef(78).url, trackerRef(79).url]))
    }
  })
})

describe("GitHub client on recorded standalone pull requests", () => {
  test("reads open, behind, conflicting, closed and missing pull requests", async () => {
    const results = await fetch(replay(fixture("standalone")), standalone)

    expect(stateOf(results, trackerRef(127))).toMatchObject(open("passed", true, true))
    expect(stateOf(results, trackerRef(120))).toMatchObject(open("passed", true, true))
    expect(stateOf(results, trackerRef(93))).toEqual(Option.some({ _tag: "Closed" }))
    expect(stateOf(results, ref("github.com/anomalyco/opencode/pull/50760"))).toMatchObject(
      Option.some({ _tag: "Open", behind: false, ci: "passed", mergeability: "conflicting" }),
    )
    expect(results.get(trackerRef(999999).url)).toEqual({
      _tag: "Failed",
      charged: false,
      diagnostic: "NotFound",
    })
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

describe("GitHub client on recorded pages of checks", () => {
  test("follows every page of checks, and paging does not change the result", async () => {
    const http = replay(fixture("paginated"))
    const paged = await fetch(http, [kubernetes(142865), trackerRef(127)])
    const unpaged = await fetch(replay(fixture("standalone")), standalone)

    expect(http.requests).toHaveLength(fixture("paginated").length)
    expect(stateOf(paged, kubernetes(142865))).toMatchObject(Option.some({ ci: "failed" }))
    expect(reportOf(paged, trackerRef(127))).toEqual(reportOf(unpaged, trackerRef(127)))
  })
})
