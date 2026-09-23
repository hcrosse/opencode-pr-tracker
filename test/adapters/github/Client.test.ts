import { describe, expect, test } from "bun:test"

import { Effect, Layer, Option, Result } from "effect"

import { layer as clientLayer } from "../../../src/adapters/github/Client.ts"
import { parsePullRequestUrl, type PullRequestRef } from "../../../src/domain/PullRequest.ts"
import type { PullRequestState } from "../../../src/domain/Snapshot.ts"
import { GitHub, type ItemResult, type Report } from "../../../src/ports/GitHub.ts"
import { fixedCommands, fixedToken, fixture, replay, type HttpFake } from "../../support/github.ts"

const ref = (url: string): PullRequestRef => Result.getOrThrow(parsePullRequestUrl(url))

const tracker = (number: number): PullRequestRef =>
  ref(`github.com/hcrosse/opencode-pr-tracker/pull/${String(number)}`)

const kubernetes = (number: number): PullRequestRef =>
  ref(`github.com/kubernetes/kubernetes/pull/${String(number)}`)

/** The pull requests recorded together in the `standalone` fixture. */
const standalone = [
  tracker(127),
  tracker(120),
  tracker(93),
  ref("github.com/anomalyco/opencode/pull/50760"),
  tracker(999999),
]

async function fetch(
  http: HttpFake,
  refs: readonly PullRequestRef[],
): Promise<ReadonlyMap<string, ItemResult>> {
  const layer = clientLayer.pipe(
    Layer.provide([http.layer, fixedToken().layer, fixedCommands({}).layer]),
  )

  const results = await Effect.runPromise(
    GitHub.use((github) => github.fetch(refs)).pipe(Effect.provide(layer)),
  )

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

const open = (ci: Ci, draft: boolean, behind: boolean): Option.Option<PullRequestState> =>
  Option.some({ _tag: "Open", behind, ci, draft, mergeability: "mergeable" })

describe("GitHub client on a recorded Stack", () => {
  test("reads a merged Stack and its members in order", async () => {
    const results = await fetch(replay(fixture("stack")), [tracker(78), tracker(79)])

    for (const member of [tracker(78), tracker(79)]) {
      expect(stateOf(results, member)).toEqual(Option.some({ _tag: "Merged" }))
      expect(
        Option.flatMap(reportOf(results, member), (report: Report) => report.membership),
      ).toMatchObject(Option.some({ _tag: "Stack", members: [tracker(78), tracker(79)] }))
    }
  })
})

describe("GitHub client on recorded standalone pull requests", () => {
  test("reads open, behind, closed and missing pull requests", async () => {
    const results = await fetch(replay(fixture("standalone")), standalone)

    expect(stateOf(results, tracker(127))).toEqual(open("passed", true, false))
    expect(stateOf(results, tracker(120))).toEqual(open("passed", true, true))
    expect(stateOf(results, tracker(93))).toEqual(Option.some({ _tag: "Closed" }))
    expect(stateOf(results, ref("github.com/anomalyco/opencode/pull/50760"))).toEqual(
      open("passed", false, false),
    )
    expect(results.get(tracker(999999).url)).toEqual({ _tag: "Failed", diagnostic: "NotFound" })
  })

  test("classifies commit statuses", async () => {
    const results = await fetch(replay(fixture("status-contexts")), [
      kubernetes(142335),
      kubernetes(142334),
    ])

    expect(stateOf(results, kubernetes(142335))).toMatchObject(Option.some({ ci: "failed" }))
    expect(stateOf(results, kubernetes(142334))).toMatchObject(Option.some({ ci: "pending" }))
  })
})

describe("GitHub client on recorded pages of checks", () => {
  test("follows every page of checks, and paging does not change the result", async () => {
    const http = replay(fixture("paginated"))
    const paged = await fetch(http, [kubernetes(142339), tracker(127)])
    const unpaged = await fetch(replay(fixture("standalone")), standalone)

    expect(http.requests).toHaveLength(fixture("paginated").length)
    expect(stateOf(paged, kubernetes(142339))).toMatchObject(Option.some({ ci: "failed" }))
    expect(reportOf(paged, tracker(127))).toEqual(reportOf(unpaged, tracker(127)))
  })
})
