import { Duration, Match, Schema } from "effect"

import { PullRequestRef } from "./PullRequest.ts"

export const Ci = Schema.Literals(["passed", "pending", "failed", "none"])

export const Mergeability = Schema.Literals(["mergeable", "conflicting", "unknown"])

export const PullRequestState = Schema.Union([
  Schema.TaggedStruct("Open", {
    behind: Schema.Boolean,
    ci: Ci,
    draft: Schema.Boolean,
    mergeability: Mergeability,
  }),
  Schema.TaggedStruct("Merged", {}),
  Schema.TaggedStruct("Closed", {}),
])

export type PullRequestState = typeof PullRequestState.Type

/** What GitHub reported for one pull request at one refresh. */
export const Snapshot = Schema.Struct({
  ref: PullRequestRef,
  state: PullRequestState,
  title: Schema.String,
})

export type Snapshot = typeof Snapshot.Type

/** Why a refresh failed, as far as a user can act on it. */
export const Diagnostic = Schema.Literals([
  "GitHubCliMissing",
  "AuthenticationRequired",
  "GitHubUnavailable",
  "NotFound",
  "InvalidResponse",
])

export type Diagnostic = typeof Diagnostic.Type

export const Status = Schema.Union([
  Schema.TaggedStruct("Pending", {}),
  Schema.TaggedStruct("Fresh", { snapshot: Snapshot }),
  Schema.TaggedStruct("Stale", {
    diagnostic: Diagnostic,
    failingSince: Schema.Int,
    snapshot: Snapshot,
  }),
  Schema.TaggedStruct("Unavailable", { diagnostic: Diagnostic }),
])

export type Status = typeof Status.Type

/** How long a pull request may keep failing before its last good snapshot is withdrawn. */
export const staleLimit = Duration.minutes(5)

export const pending: Status = { _tag: "Pending" }

export function succeeded(snapshot: Snapshot): Status {
  return { _tag: "Fresh", snapshot }
}

/** The status after a failed refresh at `now`, in epoch milliseconds. */
export function failed(status: Status, diagnostic: Diagnostic, now: number): Status {
  return Match.valueTags(status, {
    Fresh: ({ snapshot }): Status => ({ _tag: "Stale", diagnostic, failingSince: now, snapshot }),
    Pending: (): Status => ({ _tag: "Unavailable", diagnostic }),
    Stale: ({ failingSince, snapshot }): Status =>
      now - failingSince >= Duration.toMillis(staleLimit)
        ? { _tag: "Unavailable", diagnostic }
        : { _tag: "Stale", diagnostic, failingSince, snapshot },
    Unavailable: (): Status => ({ _tag: "Unavailable", diagnostic }),
  })
}
