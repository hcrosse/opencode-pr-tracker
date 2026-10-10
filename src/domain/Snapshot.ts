import { Duration, Effect, Schema, SchemaGetter } from "effect"

import { PullRequestRef } from "./PullRequest.ts"
import { amongFetched, Decision, noReview, Review, Threads } from "./Review.ts"

/** `unknown` is CI with a check GitHub reported in a form this version does not know. */
export const Ci = Schema.Literals(["passed", "pending", "failed", "none", "unknown"])

export type Ci = typeof Ci.Type

export const Mergeability = Schema.Literals(["mergeable", "conflicting", "unknown"])

export type Mergeability = typeof Mergeability.Type

/** Whether the base branch requires updating first; `unknown` is a merge state this version does not know. */
export const Behind = Schema.Union([Schema.Boolean, Schema.Literal("unknown")])

export type Behind = typeof Behind.Type

export const OpenState = Schema.TaggedStruct("Open", {
  behind: Behind,
  ci: Ci,
  draft: Schema.Boolean,
  mergeability: Mergeability,
  review: Review,
})

export type OpenState = typeof OpenState.Type

/** The parts of an open state a client from before unknown states cannot read as unknown. */
const UnknownPart = Schema.Literals(["behind", "ci", "decision"])

type UnknownPart = typeof UnknownPart.Type

/**
 * An open state as it is sent. A client from before unknown states reads each unknown part as
 * it did then: CI as pending, behind as false, and the decision as none. `unknown` names the parts
 * that are unknown, and `review.threads.unknown` counts unknown threads; such a client ignores both.
 */
const SentOpen = Schema.TaggedStruct("Open", {
  behind: Schema.Boolean,
  ci: Ci.pick(["passed", "pending", "failed", "none"]),
  draft: Schema.Boolean,
  mergeability: Mergeability,
  // A server from before review state sends none, so a newer client shows none.
  review: Schema.Struct({
    decision: Decision.pick([
      "approved",
      "staleApproval",
      "changesRequested",
      "reviewRequired",
      "none",
    ]),
    threads: Threads.pipe(
      // A server from before unknown threads sends none, so a newer client counts none.
      Schema.fieldsAssign({
        unknown: Threads.fields.unknown.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
      }),
      // Assigning fields drops the struct's own check, so it is applied again.
      Schema.check(amongFetched),
    ),
  }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({ decision: "none", threads: noReview.threads })),
  ),
  // A server from before unknown states sends none.
  unknown: Schema.Array(UnknownPart).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
})

type SentOpen = typeof SentOpen.Type

const isUnknown: Readonly<Record<UnknownPart, (state: OpenState) => boolean>> = {
  behind: (state) => state.behind === "unknown",
  ci: (state) => state.ci === "unknown",
  decision: (state) => state.review.decision === "unknown",
}

function received(sent: SentOpen): OpenState {
  const unknown = new Set(sent.unknown)

  return OpenState.make({
    behind: unknown.has("behind") ? "unknown" : sent.behind,
    ci: unknown.has("ci") ? "unknown" : sent.ci,
    draft: sent.draft,
    mergeability: sent.mergeability,
    review: {
      decision: unknown.has("decision") ? "unknown" : sent.review.decision,
      threads: sent.review.threads,
    },
  })
}

function sentOf(state: OpenState): SentOpen {
  const { decision } = state.review

  return SentOpen.make({
    behind: state.behind === true,
    ci: state.ci === "unknown" ? "pending" : state.ci,
    draft: state.draft,
    mergeability: state.mergeability,
    review: { decision: decision === "unknown" ? "none" : decision, threads: state.review.threads },
    unknown: UnknownPart.literals.filter((part) => isUnknown[part](state)),
  })
}

export const PullRequestState = Schema.Union([
  SentOpen.pipe(
    Schema.decodeTo(OpenState, {
      decode: SchemaGetter.transform(received),
      encode: SchemaGetter.transform(sentOf),
    }),
  ),
  Schema.TaggedStruct("Merged", {}),
  Schema.TaggedStruct("Closed", {}),
]).pipe(Schema.toTaggedUnion("_tag"))

export type PullRequestState = typeof PullRequestState.Type

/** What GitHub reported for one pull request at one refresh. */
export const Snapshot = Schema.Struct({
  ref: PullRequestRef,
  state: PullRequestState,
  title: Schema.String,
})

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

/** Why a refresh failed, as far as a user can act on it. */
export const Diagnostic = Schema.Literals([
  "GitHubCliMissing",
  "AuthenticationRequired",
  "GitHubUnavailable",
  "NotFound",
  "InvalidResponse",
  "RateLimited",
])

export type Diagnostic = typeof Diagnostic.Type

export const Status = Schema.TaggedUnion({
  Pending: {},
  Fresh: { snapshot: Snapshot },
  Stale: {
    diagnostic: Diagnostic,
    failingSince: Schema.Int,
    snapshot: Snapshot,
  },
  Unavailable: { diagnostic: Diagnostic },
})

export type Status = typeof Status.Type

/** How long a pull request may keep failing before its last good snapshot is withdrawn. */
export const staleLimit = Duration.minutes(5)

export const pending: Status = Status.cases.Pending.make({})

export function succeeded(snapshot: Snapshot): Status {
  return Status.cases.Fresh.make({ snapshot })
}

/**
 * The status after a failed refresh at `now`, in epoch milliseconds. A rate-limited refresh keeps
 * the last snapshot for as long as the limit lasts.
 */
export function failed(status: Status, diagnostic: Diagnostic, now: number): Status {
  return Status.match(status, {
    Fresh: ({ snapshot }) => Status.cases.Stale.make({ diagnostic, failingSince: now, snapshot }),
    Pending: () => Status.cases.Unavailable.make({ diagnostic }),
    Stale: ({ failingSince, snapshot }) =>
      diagnostic !== "RateLimited" && now - failingSince >= Duration.toMillis(staleLimit)
        ? Status.cases.Unavailable.make({ diagnostic })
        : Status.cases.Stale.make({ diagnostic, failingSince, snapshot }),
    Unavailable: () => Status.cases.Unavailable.make({ diagnostic }),
  })
}
