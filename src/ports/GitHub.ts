import { Context, Data, Option, Schema, type Effect } from "effect"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import { Diagnostic, type Snapshot } from "../domain/Snapshot.ts"
import type { Membership } from "../domain/StackLayout.ts"

/** Everything one refresh learns about a pull request. */
export interface Report {
  readonly snapshot: Snapshot
  /** None when GitHub's Stack data was incomplete. */
  readonly membership: Option.Option<Membership>
  /** Canonical URLs of the Stack members GitHub reports as merged or closed. Empty when standalone. */
  readonly nonOpenMembers: readonly string[]
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
  | Data.TaggedEnum<{
      Reported: { readonly report: Report }
      Failed: { readonly diagnostic: Diagnostic; readonly charged: false }
    }>
  | Data.TaggedEnum<{
      Failed: { readonly diagnostic: "GitHubUnavailable"; readonly charged: true }
    }>

type ItemResultConstructors = Omit<Data.TaggedEnum.Constructor<ItemResult>, "Failed"> & {
  readonly Failed: (fields: FailedFields) => FailedItemResult
}

type FailedItemResult = Extract<ItemResult, { readonly _tag: "Failed" }>

type FailedFields<Value = FailedItemResult> = Value extends { readonly _tag: "Failed" }
  ? Omit<Value, "_tag">
  : never

const itemResult = Data.taggedEnum<ItemResult>()

export const ItemResult: ItemResultConstructors = {
  Reported: (fields) => itemResult.Reported(fields),
  Failed: (fields) => itemResult.Failed(fields),
  $is: itemResult.$is,
  $match: itemResult.$match,
}

export const failed = (diagnostic: Diagnostic): ItemResult =>
  ItemResult.Failed({ charged: false, diagnostic })

export const charged: ItemResult = ItemResult.Failed({
  charged: true,
  diagnostic: "GitHubUnavailable",
})

export interface GitHubApi {
  /**
   * Reports for pull requests, keyed by canonical URL. Large requests are split into batches. Fails
   * as a whole only when every batch failed without costing GitHub work.
   */
  readonly fetch: (
    refs: readonly PullRequestRef[],
  ) => Effect.Effect<ReadonlyMap<string, ItemResult>, GitHubFailure>
  /** The pull request `number` in the GitHub repository checked out at `directory`. */
  readonly pullRequestInRepository: (
    directory: string,
    number: number,
  ) => Effect.Effect<PullRequestRef, GitHubFailure | RepositoryUnavailable>
}

/** Larger batches approach GitHub's 10-second query limit, and a timeout fails the whole batch. */
export const maximumBatch = 5

export class GitHub extends Context.Service<GitHub, GitHubApi>()("opencode-pr-tracker/GitHub") {}
