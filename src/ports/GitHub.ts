import { Context, Option, Schema, type Effect } from "effect"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import { Diagnostic, type Snapshot } from "../domain/Snapshot.ts"
import type { Membership } from "../domain/StackLayout.ts"

/** Everything one refresh learns about a pull request. */
export interface Report {
  readonly snapshot: Snapshot
  /** None when GitHub's Stack data was incomplete. */
  readonly membership: Option.Option<Membership>
}

/** A failure that affects the whole request rather than one pull request. */
export class GitHubFailure extends Schema.TaggedError<GitHubFailure>()("GitHubFailure", {
  diagnostic: Diagnostic,
}) {}

/** The directory is not a GitHub repository `gh` can see, so a bare number cannot be resolved. */
export class RepositoryUnavailable extends Schema.TaggedError<RepositoryUnavailable>()(
  "RepositoryUnavailable",
  { directory: Schema.String },
) {}

export type ItemResult =
  | { readonly _tag: "Reported"; readonly report: Report }
  | { readonly _tag: "Failed"; readonly diagnostic: Diagnostic }

export interface GitHubApi {
  /** Reports for pull requests, keyed by canonical URL. Large requests are split into batches. */
  readonly fetch: (
    refs: readonly PullRequestRef[],
  ) => Effect.Effect<ReadonlyMap<string, ItemResult>, GitHubFailure>
  /** The pull request `number` in the GitHub repository checked out at `directory`. */
  readonly pullRequestInRepository: (
    directory: string,
    number: number,
  ) => Effect.Effect<PullRequestRef, GitHubFailure | RepositoryUnavailable>
}

export const maximumBatch = 20

export class GitHub extends Context.Service<GitHub, GitHubApi>()("opencode-pr-tracker/GitHub") {}
