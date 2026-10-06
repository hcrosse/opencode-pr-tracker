import { describe, expect, test } from "bun:test"

import { Duration, Option, Result } from "effect"

import { parsePullRequestUrl } from "../../src/domain/PullRequest.ts"
import { nextRefresh } from "../../src/domain/RefreshPolicy.ts"
import {
  failed,
  succeeded,
  type Ci,
  type Mergeability,
  type PullRequestState,
  type Status,
} from "../../src/domain/Snapshot.ts"

const ref = Result.getOrThrow(parsePullRequestUrl("github.com/acme/api/pull/1"))

const fresh = (state: PullRequestState): Status => succeeded({ ref, state, title: "Title" })

const openWith = (ci: Ci, mergeability: Mergeability): Status =>
  fresh({ _tag: "Open", behind: false, ci, draft: false, mergeability })

describe("nextRefresh", () => {
  test.each([
    ["an open pull request with checks running", openWith("pending", "mergeable")],
    ["an open pull request whose mergeability GitHub is computing", openWith("passed", "unknown")],
    ["a pull request that has not loaded", { _tag: "Pending" } satisfies Status],
    [
      "an unavailable pull request",
      { _tag: "Unavailable", diagnostic: "GitHubUnavailable" } satisfies Status,
    ],
    [
      "a merged pull request whose last refresh failed",
      failed(fresh({ _tag: "Merged" }), "GitHubUnavailable", 0),
    ],
  ])("refreshes %s every 15 seconds", (_name, status) => {
    expect(nextRefresh(status, 0)).toEqual(Option.some(Duration.seconds(15)))
  })

  test.each([
    ["passing", openWith("passed", "mergeable")],
    ["conflicting", openWith("failed", "conflicting")],
    ["without checks", openWith("none", "mergeable")],
  ])("refreshes a settled open pull request %s every minute", (_name, status) => {
    expect(nextRefresh(status, 0)).toEqual(Option.some(Duration.seconds(60)))
  })

  test("refreshes a closed pull request, which may be reopened, every 5 minutes", () => {
    expect(nextRefresh(fresh({ _tag: "Closed" }), 0)).toEqual(Option.some(Duration.minutes(5)))
  })

  test("stops refreshing a merged pull request", () => {
    expect(nextRefresh(fresh({ _tag: "Merged" }), 0)).toEqual(Option.none())
  })
})

describe("nextRefresh after charged failures", () => {
  test.each([
    [1, 15],
    [2, 30],
    [3, 60],
    [6, 480],
    [7, 900],
    [40, 900],
  ])("after %i charged failures, retries in %i seconds", (failures, seconds) => {
    const status = failed(fresh({ _tag: "Closed" }), "GitHubUnavailable", 0)

    expect(nextRefresh(status, failures)).toEqual(Option.some(Duration.seconds(seconds)))
  })

  test("keeps a successful refresh's interval whatever failed before", () => {
    expect(nextRefresh(openWith("pending", "mergeable"), 5)).toEqual(
      Option.some(Duration.seconds(15)),
    )
  })
})
