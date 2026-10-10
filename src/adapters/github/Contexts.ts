/** Check contexts: how GitHub reports them, following their pages, and what each means as a check. */
import { Effect, Option, Schema } from "effect"

import type { Check, CheckOutcome } from "../../domain/Checks.ts"
import type { PullRequestRef } from "../../domain/PullRequest.ts"
import { enumeration, Unrecognized } from "./Enumeration.ts"
import { failure, type Post } from "./Post.ts"
import { continuation, continuationVariables } from "./Query.ts"

const PageInfo = Schema.Struct({
  endCursor: Schema.NullOr(Schema.String),
  hasNextPage: Schema.Boolean,
})

const StatusState = enumeration("StatusContext.state", [
  "EXPECTED",
  "PENDING",
  "SUCCESS",
  "ERROR",
  "FAILURE",
])

const CheckStatus = enumeration("CheckRun.status", [
  "COMPLETED",
  "IN_PROGRESS",
  "PENDING",
  "QUEUED",
  "REQUESTED",
  "WAITING",
])

const CheckConclusion = enumeration("CheckRun.conclusion", [
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "NEUTRAL",
  "SKIPPED",
  "STALE",
  "STARTUP_FAILURE",
  "SUCCESS",
  "TIMED_OUT",
])

type KnownStatusState = (typeof StatusState.members)[0]["Type"]

type KnownConclusion = (typeof CheckConclusion.members)[0]["Type"]

const timestamp = /^(?<seconds>[^.]+?)(?:\.(?<fraction>\d+))?Z$/u

/** `[epochSeconds, nanoseconds]`, so runs created in the same second still order correctly. */
export function generationOf(createdAt: string): readonly number[] {
  const match = timestamp.exec(createdAt)
  const groups = match === null ? {} : (match.groups ?? {})
  const seconds = Date.parse(`${groups["seconds"] ?? ""}Z`) / 1000
  const nanoseconds = Number((groups["fraction"] ?? "").padEnd(9, "0").slice(0, 9))

  return [Number.isFinite(seconds) ? seconds : 0, nanoseconds]
}

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
    id: Schema.String,
    workflowRun: Schema.NullOr(
      Schema.Struct({
        event: Schema.String,
        runAttempt: Schema.Int,
        runNumber: Schema.Int,
        workflow: Schema.Struct({ id: Schema.String }),
      }),
    ),
  }),
  conclusion: Schema.NullOr(CheckConclusion),
  name: Schema.String,
  status: CheckStatus,
})

type CheckRunNode = typeof CheckRunNode.Type

export const ContextNode = Schema.Union([StatusContextNode, CheckRunNode])

export type ContextNode = typeof ContextNode.Type

export const Contexts = Schema.Struct({
  nodes: Schema.Array(ContextNode),
  pageInfo: PageInfo,
})

export type Contexts = typeof Contexts.Type

const ContinuationData = Schema.Struct({
  repository: Schema.Struct({
    pullRequest: Schema.Struct({ statusCheckRollup: Schema.Struct({ contexts: Contexts }) }),
  }),
})

/** How the client asks GitHub: by posting queries, for `pageSize` check contexts a page. */
export interface Asking {
  readonly post: Post
  readonly pageSize: number
}

/** A pull request's check contexts as its node reports them: none, or a first page. */
export type Rollup = Readonly<{ contexts: Contexts }> | null

/** Every check context for a pull request, following continuation pages. */
export const allContexts = Effect.fn("allContexts")(function* (
  { pageSize, post }: Asking,
  ref: PullRequestRef,
  rollup: Rollup,
) {
  const collected: ContextNode[] = []
  const followed = new Set<string>()
  let page = Option.map(Option.fromNullishOr(rollup), (found) => found.contexts)

  while (Option.isSome(page)) {
    collected.push(...page.value.nodes)

    if (!page.value.pageInfo.hasNextPage) break

    // A claimed next page needs a new cursor, or CI would be judged on part or paging never end.
    const after = page.value.pageInfo.endCursor ?? ""

    if (after === "" || followed.has(after)) return yield* failure("InvalidResponse")

    followed.add(after)

    const envelope = yield* post(continuation(pageSize), continuationVariables(ref, after))

    if ((envelope.errors ?? []).length > 0) return yield* failure("InvalidResponse")

    const data = yield* Schema.decodeUnknownEffect(ContinuationData)(envelope.data).pipe(
      Effect.mapError(() => failure("InvalidResponse")),
    )

    page = Option.some(data.repository.pullRequest.statusCheckRollup.contexts)
  }

  return collected
})

const conclusionOutcomes: Readonly<Record<KnownConclusion, CheckOutcome>> = {
  ACTION_REQUIRED: "failed",
  CANCELLED: "failed",
  FAILURE: "failed",
  NEUTRAL: "ignored",
  SKIPPED: "ignored",
  STALE: "failed",
  STARTUP_FAILURE: "failed",
  SUCCESS: "passed",
  TIMED_OUT: "failed",
}

/** A run GitHub reports as completed without a conclusion has an unknown outcome. */
function checkRunOutcome({ conclusion, status }: CheckRunNode): CheckOutcome {
  if (status instanceof Unrecognized) return "unknown"

  if (status !== "COMPLETED") return "pending"

  if (conclusion === null || conclusion instanceof Unrecognized) return "unknown"

  return conclusionOutcomes[conclusion]
}

const statusOutcomes: Readonly<Record<KnownStatusState, CheckOutcome>> = {
  ERROR: "failed",
  EXPECTED: "pending",
  FAILURE: "failed",
  PENDING: "pending",
  SUCCESS: "passed",
}

/**
 * Status contexts are one check per context name. The jobs of a workflow run are one check,
 * identified by app, workflow and event and ordered by run and attempt, so a newer run replaces
 * every job of an older one, including jobs it no longer has. Any other check run is identified
 * by its app (or suite) and name, and ordered by when its suite was created.
 */
export function toCheck(node: ContextNode): Check {
  if (node.__typename === "StatusContext") {
    const identity = `status ${node.context.toLowerCase()}`
    const { state } = node

    return {
      generation: generationOf(node.createdAt),
      identity,
      outcome: state instanceof Unrecognized ? "unknown" : statusOutcomes[state],
    }
  }

  const outcome = checkRunOutcome(node)

  // Runs of one app's check replace each other across suites; without an app, each suite stands alone.
  const source =
    node.checkSuite.app === null ? `suite ${node.checkSuite.id}` : `app ${node.checkSuite.app.id}`

  return Option.match(Option.fromNullishOr(node.checkSuite.workflowRun), {
    onNone: (): Check => ({
      generation: generationOf(node.checkSuite.createdAt),
      identity: `check ${source} ${node.name}`,
      outcome,
    }),
    onSome: (run): Check => ({
      generation: [run.runNumber, run.runAttempt],
      identity: `workflow ${source} ${run.workflow.id} ${run.event}`,
      outcome,
    }),
  })
}
