import { describe, expect, test } from "bun:test"

import { Duration, Option, Result } from "effect"

import { parsePullRequestUrl } from "../../src/domain/PullRequest.ts"
import { nextRefresh } from "../../src/domain/RefreshPolicy.ts"
import { failed, succeeded, type PullRequestState, type Status } from "../../src/domain/Snapshot.ts"

const ref = Result.getOrThrow(parsePullRequestUrl("github.com/acme/api/pull/1"))

const fresh = (state: PullRequestState): Status => succeeded({ ref, state, title: "Title" })

const openState: PullRequestState = {
  _tag: "Open",
  behind: false,
  ci: "pending",
  draft: false,
  mergeability: "unknown",
}

describe("nextRefresh", () => {
  test.each([
    ["an open pull request", fresh(openState)],
    ["a closed pull request, which may be reopened", fresh({ _tag: "Closed" })],
    ["a pull request that has not loaded", { _tag: "Pending" } satisfies Status],
    [
      "an unavailable pull request",
      { _tag: "Unavailable", diagnostic: "GitHubUnavailable" } satisfies Status,
    ],
  ])("refreshes %s every 15 seconds", (_name, status) => {
    expect(nextRefresh(status)).toEqual(Option.some(Duration.seconds(15)))
  })

  test.each([
    ["a merged pull request", fresh({ _tag: "Merged" })],
    [
      "a merged pull request whose last refresh failed",
      failed(fresh({ _tag: "Merged" }), "GitHubUnavailable", 0),
    ],
  ])("stops refreshing %s", (_name, status) => {
    expect(nextRefresh(status)).toEqual(Option.none())
  })
})
