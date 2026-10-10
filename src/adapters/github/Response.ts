import { Array as Arr, Option, Result, Schema } from "effect"

import { classifyCi } from "../../domain/Checks.ts"
import type { PullRequestRef } from "../../domain/PullRequest.ts"
import type { Review } from "../../domain/Review.ts"
import { PullRequestState, type Diagnostic, type Mergeability } from "../../domain/Snapshot.ts"
import type { ItemResult, Report } from "../../ports/GitHub.ts"
import { Contexts, toCheck, type ContextNode } from "./Contexts.ts"
import { enumeration, Unrecognized, unrecognizedAmong } from "./Enumeration.ts"
import { LifecycleState, nonOpenMembersOf, StackNode, toMembership } from "./Stacks.ts"

const MergeStateStatus = enumeration("PullRequest.mergeStateStatus", [
  "BEHIND",
  "BLOCKED",
  "CLEAN",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
])

const MergeableState = Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"])

type MergeableState = typeof MergeableState.Type

export const PullRequestNode = Schema.Struct({
  isDraft: Schema.Boolean,
  mergeStateStatus: MergeStateStatus,
  mergeable: MergeableState,
  stack: Schema.NullOr(StackNode),
  state: LifecycleState,
  statusCheckRollup: Schema.NullOr(Schema.Struct({ contexts: Contexts })),
  title: Schema.String,
})

export interface PullRequestNode extends Schema.Schema.Type<typeof PullRequestNode> {}

const mergeabilities: Readonly<Record<MergeableState, Mergeability>> = {
  CONFLICTING: "conflicting",
  MERGEABLE: "mergeable",
  UNKNOWN: "unknown",
}

/** The enumeration values in a pull request node and its check contexts this version does not know. */
export function unrecognizedIn(
  node: PullRequestNode,
  contexts: readonly ContextNode[],
): Unrecognized[] {
  const values = contexts.flatMap((context) =>
    context.__typename === "StatusContext" ? [context.state] : [context.status, context.conclusion],
  )

  return unrecognizedAmong([node.mergeStateStatus, ...values])
}

/** What the client gathered beside the pull request node: every check context, and the review state. */
export interface Details {
  readonly contexts: readonly ContextNode[]
  readonly review: Review
}

function toState(node: PullRequestNode, { contexts, review }: Details): PullRequestState {
  if (node.state === "MERGED") return PullRequestState.cases.Merged.make({})

  if (node.state === "CLOSED") return PullRequestState.cases.Closed.make({})

  return PullRequestState.cases.Open.make({
    behind:
      node.mergeStateStatus instanceof Unrecognized
        ? "unknown"
        : node.mergeStateStatus === "BEHIND",
    ci: classifyCi(contexts.map((context) => toCheck(context))),
    draft: node.isDraft,
    mergeability: mergeabilities[node.mergeable],
    review,
  })
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
