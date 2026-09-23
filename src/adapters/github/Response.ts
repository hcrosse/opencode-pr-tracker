import { Array as Arr, Option, Result, Schema } from "effect"

import { classifyCi, type Check, type CheckOutcome } from "../../domain/Checks.ts"
import { parsePullRequestUrl, type PullRequestRef } from "../../domain/PullRequest.ts"
import type { Diagnostic, PullRequestState } from "../../domain/Snapshot.ts"
import type { Membership } from "../../domain/StackLayout.ts"
import type { ItemResult, Report } from "../../ports/GitHub.ts"

const PageInfo = Schema.Struct({
  endCursor: Schema.NullOr(Schema.String),
  hasNextPage: Schema.Boolean,
})

const StatusState = Schema.Literals(["EXPECTED", "PENDING", "SUCCESS", "ERROR", "FAILURE"])

type StatusState = typeof StatusState.Type

const StatusContextNode = Schema.Struct({
  __typename: Schema.Literal("StatusContext"),
  context: Schema.String,
  createdAt: Schema.String,
  state: StatusState,
})

const CheckRunNode = Schema.Struct({
  __typename: Schema.Literal("CheckRun"),
  checkSuite: Schema.Struct({
    app: Schema.NullOr(Schema.Struct({ id: Schema.String })),
    createdAt: Schema.String,
    workflowRun: Schema.NullOr(
      Schema.Struct({
        event: Schema.String,
        runAttempt: Schema.Int,
        runNumber: Schema.Int,
        workflow: Schema.Struct({ id: Schema.String }),
      }),
    ),
  }),
  conclusion: Schema.NullOr(Schema.String),
  name: Schema.String,
  status: Schema.String,
})

export const ContextNode = Schema.Union([StatusContextNode, CheckRunNode])

export type ContextNode = typeof ContextNode.Type

export const Contexts = Schema.Struct({
  nodes: Schema.Array(ContextNode),
  pageInfo: PageInfo,
  totalCount: Schema.Int,
})

export type Contexts = typeof Contexts.Type

const StackNode = Schema.Struct({
  entries: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({ position: Schema.Int, pullRequest: Schema.Struct({ url: Schema.String }) }),
    ),
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
    totalCount: Schema.Int,
  }),
  id: Schema.String,
  size: Schema.Int,
})

export const PullRequestNode = Schema.Struct({
  __typename: Schema.Literal("PullRequest"),
  isDraft: Schema.Boolean,
  mergeStateStatus: Schema.String,
  mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  stack: Schema.NullOr(StackNode),
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  statusCheckRollup: Schema.NullOr(Schema.Struct({ contexts: Contexts })),
  title: Schema.String,
  url: Schema.String,
})

export type PullRequestNode = typeof PullRequestNode.Type

const failedConclusions = new Set([
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "STALE",
])

const timestamp = /^(?<seconds>[^.]+?)(?:\.(?<fraction>\d+))?Z$/u

/** `[epochSeconds, nanoseconds]`, so runs created in the same second still order correctly. */
export function generationOf(createdAt: string): readonly number[] {
  const match = timestamp.exec(createdAt)
  const groups = match === null ? {} : (match.groups ?? {})
  const seconds = Date.parse(`${groups["seconds"] ?? ""}Z`) / 1000
  const nanoseconds = Number((groups["fraction"] ?? "").padEnd(9, "0").slice(0, 9))

  return [Number.isFinite(seconds) ? seconds : 0, nanoseconds]
}

function checkRunOutcome(status: string, conclusion: string | null): CheckOutcome {
  if (status !== "COMPLETED") return "pending"

  if (conclusion === "SUCCESS") return "passed"

  return failedConclusions.has(conclusion ?? "") ? "failed" : "ignored"
}

const statusOutcomes: Record<StatusState, CheckOutcome> = {
  ERROR: "failed",
  EXPECTED: "pending",
  FAILURE: "failed",
  PENDING: "pending",
  SUCCESS: "passed",
}

/**
 * Status contexts are one check per context name. A workflow check is identified by its app,
 * workflow, event and name, and ordered by run and attempt. Any other check run is identified by
 * its app (or suite) and name, and ordered by when its suite was created.
 */
export function toCheck(node: ContextNode): Check {
  if (node.__typename === "StatusContext") {
    const identity = `status ${node.context.toLowerCase()}`

    return {
      generation: generationOf(node.createdAt),
      identity,
      outcome: statusOutcomes[node.state],
    }
  }

  const outcome = checkRunOutcome(node.status, node.conclusion)
  const source = node.checkSuite.app === null ? "suite" : `app ${node.checkSuite.app.id}`

  return Option.match(Option.fromNullishOr(node.checkSuite.workflowRun), {
    onNone: () => ({
      generation: generationOf(node.checkSuite.createdAt),
      identity: `check ${source} ${node.name}`,
      outcome,
    }),
    onSome: (run) => ({
      generation: [run.runNumber, run.runAttempt],
      identity: `workflow ${source} ${run.workflow.id} ${run.event} ${node.name}`,
      outcome,
    }),
  })
}

function toState(node: PullRequestNode, contexts: readonly ContextNode[]): PullRequestState {
  if (node.state === "MERGED") return { _tag: "Merged" }

  if (node.state === "CLOSED") return { _tag: "Closed" }

  return {
    _tag: "Open",
    behind: node.mergeStateStatus === "BEHIND",
    ci: classifyCi(contexts.map((context) => toCheck(context))),
    draft: node.isDraft,
    mergeability:
      node.mergeable === "MERGEABLE"
        ? "mergeable"
        : node.mergeable === "CONFLICTING"
          ? "conflicting"
          : "unknown",
  }
}

/** None when GitHub returned only part of the Stack, or a member URL we cannot parse. */
export function toMembership(node: PullRequestNode): Option.Option<Membership> {
  if (node.stack === null) return Option.some({ _tag: "Standalone" })

  const { entries, id, size } = node.stack
  const ordered = entries.nodes.toSorted((left, right) => left.position - right.position)

  const members = ordered.flatMap((entry) =>
    Option.toArray(Result.getSuccess(parsePullRequestUrl(entry.pullRequest.url))),
  )

  const complete = !entries.pageInfo.hasNextPage && members.length === size

  return complete && Arr.isArrayNonEmpty(members)
    ? Option.some({ _tag: "Stack", id, members })
    : Option.none()
}

export function toReport(
  ref: PullRequestRef,
  node: PullRequestNode,
  contexts: readonly ContextNode[],
): Report {
  return {
    membership: toMembership(node),
    snapshot: { ref, state: toState(node, contexts), title: node.title },
  }
}

export type Entry = readonly [url: string, result: ItemResult]

/** One batch's results, and why it failed as a whole, if it did. */
export interface BatchOutcome {
  readonly entries: readonly Entry[]
  readonly failure: Option.Option<Diagnostic>
}

/** Every batch's results together, or a failure when every batch failed. */
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
