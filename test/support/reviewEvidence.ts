import * as gs from "@hegeldev/hegel/generators"
import { Option } from "effect"

import type {
  OpinionatedReview,
  ReportedDecision,
  ReviewEvidence,
  ReviewThread,
  ThreadComment,
} from "../../src/domain/Review.ts"

export const author = "author"

export const head = "head"

/** A login, or none for a deleted (ghost) account. Includes the pull request's author. */
const logins: gs.Generator<Option.Option<string>> = gs.oneOf(
  gs.just(Option.none<string>()),
  gs
    .sampledFrom([author, "reviewer", "copilot-pull-request-reviewer"])
    .map((login: string) => Option.some(login)),
)

const commits: gs.Generator<Option.Option<string>> = gs.oneOf(
  gs.just(Option.none<string>()),
  gs.sampledFrom([head, "older"]).map((oid: string) => Option.some(oid)),
)

const opinionatedReviews: gs.Generator<OpinionatedReview> = gs.record({
  commit: commits,
  verdict: gs.sampledFrom<OpinionatedReview["verdict"]>([
    "approved",
    "changesRequested",
    "other",
    "unknown",
  ]),
})

export const comments: gs.Generator<ThreadComment> = gs.record({
  author: logins,
  submitted: gs.oneOf<boolean | "unknown">(gs.booleans(), gs.just("unknown" as const)),
})

export const threads = (resolved: Readonly<gs.Generator<boolean>>): gs.Generator<ReviewThread> =>
  gs.record({ comments: gs.arrays(comments, { maxSize: 5 }), resolved })

export const reported = gs.sampledFrom<ReportedDecision>([
  "approved",
  "changesRequested",
  "reviewRequired",
  "unreported",
  "unknown",
])

export interface EvidenceOptions {
  readonly reported?: gs.Generator<ReportedDecision>
  readonly reviews?: gs.Generator<OpinionatedReview[]>
  readonly author?: gs.Generator<Option.Option<string>>
  /** Whether GitHub had more writers' reviews; by default it had none. */
  readonly moreReviews?: gs.Generator<boolean>
}

export const evidence = (options: EvidenceOptions = {}): gs.Generator<ReviewEvidence> =>
  gs.record({
    author: options.author ?? gs.just(Option.some(author)),
    head: gs.just(head),
    moreReviews: options.moreReviews ?? gs.just(false),
    moreThreads: gs.booleans(),
    reported: options.reported ?? reported,
    reviews: options.reviews ?? gs.arrays(opinionatedReviews, { maxSize: 6 }),
    threads: gs.arrays(threads(gs.booleans()), { maxSize: 20 }),
  })

/** The evidence with `change` applied to its threads. */
export const withThreads = (
  base: ReviewEvidence,
  changed: readonly ReviewThread[],
): ReviewEvidence => ({
  author: base.author,
  head: base.head,
  moreReviews: base.moreReviews,
  moreThreads: base.moreThreads,
  reported: base.reported,
  reviews: base.reviews,
  threads: changed,
})
