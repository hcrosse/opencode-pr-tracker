import { Array as Arr, Option, Result, Schema } from "effect"

import { classifyCi } from "../../domain/Checks.ts"
import type { PullRequestRef } from "../../domain/PullRequest.ts"
import type { Review } from "../../domain/Review.ts"
import type { Diagnostic, Mergeability, PullRequestState } from "../../domain/Snapshot.ts"
import type { ItemResult, Report } from "../../ports/GitHub.ts"
import { Contexts, toCheck, type ContextNode } from "./Contexts.ts"
import { LifecycleState, nonOpenMembersOf, StackNode, toMembership } from "./Stacks.ts"

const MergeableState = Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"])

type MergeableState = typeof MergeableState.Type

export const PullRequestNode = Schema.Struct({
  isDraft: Schema.Boolean,
  mergeStateStatus: Schema.String,
  mergeable: MergeableState,
  stack: Schema.NullOr(StackNode),
  state: LifecycleState,
  statusCheckRollup: Schema.NullOr(Schema.Struct({ contexts: Contexts })),
  title: Schema.String,
})

export type PullRequestNode = typeof PullRequestNode.Type

const mergeabilities: Record<MergeableState, Mergeability> = {
  CONFLICTING: "conflicting",
  MERGEABLE: "mergeable",
  UNKNOWN: "unknown",
}

/** What the client gathered beside the pull request node: every check context, and the review state. */
export interface Details {
  readonly contexts: readonly ContextNode[]
  readonly review: Review
}

function toState(node: PullRequestNode, { contexts, review }: Details): PullRequestState {
  if (node.state === "MERGED") return { _tag: "Merged" }

  if (node.state === "CLOSED") return { _tag: "Closed" }

  return {
    _tag: "Open",
    behind: node.mergeStateStatus === "BEHIND",
    ci: classifyCi(contexts.map((context) => toCheck(context))),
    draft: node.isDraft,
    mergeability: mergeabilities[node.mergeable],
    review,
  }
}

export function toReport(ref: PullRequestRef, node: PullRequestNode, details: Details): Report {
  return {
    membership: toMembership(node),
    nonOpenMembers: nonOpenMembersOf(node),
    snapshot: { ref, state: toState(node, details), title: node.title },
  }
}

export type Entry = readonly [url: string, result: ItemResult]

/** One batch's results, and why it failed as a whole, if it did without costing GitHub work. */
export interface BatchOutcome {
  readonly entries: readonly Entry[]
  readonly failure: Option.Option<Diagnostic>
}

/** Every batch's results together, or a failure when every batch failed at no cost to GitHub. */
export function combined(
  outcomes: readonly BatchOutcome[],
): Result.Result<ReadonlyMap<string, ItemResult>, Diagnostic> {
  const failures = outcomes.flatMap((outcome) => Option.toArray(outcome.failure))
  const everyBatchFailed = failures.length === outcomes.length

  return Option.match(
    Option.filter(Arr.head(failures), () => everyBatchFailed),
    {
      onNone: () => Result.succeed(new Map(outcomes.flatMap((outcome) => outcome.entries))),
      onSome: (diagnostic) => Result.fail(diagnostic),
    },
  )
}
