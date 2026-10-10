import { Array as Arr, Option, Schema } from "effect"

/** Which review state the tracker fetches and shows: none, or decisions and review threads. */
export const ReviewMode = Schema.Literals(["off", "all"])

export type ReviewMode = typeof ReviewMode.Type

/** Where an open pull request stands with its reviewers. */
export const Decision = Schema.Literals([
  "approved",
  "staleApproval",
  "changesRequested",
  "reviewRequired",
  "none",
])

export type Decision = typeof Decision.Type

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * Unresolved review threads among the `fetched` ones, by whether the pull request's author
 * answered last. When `complete` is false, GitHub had more threads, so the counts are lower bounds.
 */
export const Threads = Schema.Struct({
  complete: Schema.Boolean,
  fetched: Count,
  replied: Count,
  unreplied: Count,
}).check(
  Schema.makeFilter(
    (threads) =>
      threads.replied + threads.unreplied <= threads.fetched ||
      "replied and unreplied threads must be among the fetched ones",
  ),
)

export type Threads = typeof Threads.Type

export const Review = Schema.Struct({ decision: Decision, threads: Threads })

export type Review = typeof Review.Type

export const noReview: Review = {
  decision: "none",
  threads: { complete: true, fetched: 0, replied: 0, unreplied: 0 },
}

/** GitHub's own decision. It reports none when the base branch requires no review. */
export type ReportedDecision =
  | "approved"
  | "changesRequested"
  | "reviewRequired"
  | "unreported"
  | "unrecognized"

/** The latest approving, change-requesting or other opinionated review of one writer. */
export interface OpinionatedReview {
  readonly verdict: "approved" | "changesRequested" | "other"
  readonly commit: Option.Option<string>
}

export interface ThreadComment {
  /** False for a comment its author has not yet submitted, which only its author can see. */
  readonly submitted: boolean
  readonly author: Option.Option<string>
}

export interface ReviewThread {
  readonly resolved: boolean
  /** The thread's latest comments, oldest first. */
  readonly comments: readonly ThreadComment[]
}

/** What GitHub reports about the reviews of one open pull request. */
export interface ReviewEvidence {
  readonly reported: ReportedDecision
  readonly head: string
  readonly author: Option.Option<string>
  readonly reviews: readonly OpinionatedReview[]
  /** GitHub had more writers' reviews than `reviews` holds. */
  readonly moreReviews: boolean
  readonly threads: readonly ReviewThread[]
  readonly moreThreads: boolean
}

/** Changes requested by any writer win, then any approval; review required is never derived. */
function derivedDecision(reviews: readonly OpinionatedReview[]): Decision {
  if (reviews.some((review) => review.verdict === "changesRequested")) return "changesRequested"

  return reviews.some((review) => review.verdict === "approved") ? "approved" : "none"
}

/** Derived only from every writer's review, never from part of them. */
function reportedDecision(evidence: ReviewEvidence): Decision {
  if (evidence.reported === "unreported" && !evidence.moreReviews)
    return derivedDecision(evidence.reviews)

  if (evidence.reported === "unreported" || evidence.reported === "unrecognized") return "none"

  return evidence.reported
}

const approvesHead = (evidence: ReviewEvidence): boolean =>
  evidence.reviews.some(
    (review) => review.verdict === "approved" && Option.contains(review.commit, evidence.head),
  )

/**
 * An approval with no approving review of the head commit is stale. Without every writer's review,
 * an approval of the head commit may be among those missing, so the approval is kept.
 */
export function decisionOf(evidence: ReviewEvidence): Decision {
  const decision = reportedDecision(evidence)
  const stale = decision === "approved" && !evidence.moreReviews && !approvesHead(evidence)

  return stale ? "staleApproval" : decision
}

/** Replied when the latest submitted comment is the author's; resolved threads are not asked. */
function replied(thread: ReviewThread, author: Option.Option<string>): boolean {
  const last = Arr.findLast(thread.comments, (comment) => comment.submitted)
  const login = Option.flatMap(last, (comment) => comment.author)

  return Option.exists(login, (name) => Option.contains(author, name))
}

export function threadsOf(evidence: ReviewEvidence): Threads {
  const unresolved = evidence.threads.filter((thread) => !thread.resolved)
  const answered = unresolved.filter((thread) => replied(thread, evidence.author)).length

  return {
    complete: !evidence.moreThreads,
    fetched: evidence.threads.length,
    replied: answered,
    unreplied: unresolved.length - answered,
  }
}

export function reviewOf(evidence: ReviewEvidence): Review {
  return { decision: decisionOf(evidence), threads: threadsOf(evidence) }
}
