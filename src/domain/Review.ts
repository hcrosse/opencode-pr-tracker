import { Array as Arr, Option, Schema } from "effect"

/** Which review state the tracker fetches and shows: none, or decisions and review threads. */
export const ReviewMode = Schema.Literals(["off", "all"])

export type ReviewMode = typeof ReviewMode.Type

/**
 * Where an open pull request stands with its reviewers. `unknown` is a decision, or a review it
 * depends on, that GitHub reported in a form this version does not know.
 */
export const Decision = Schema.Literals([
  "approved",
  "staleApproval",
  "changesRequested",
  "reviewRequired",
  "none",
  "unknown",
])

export type Decision = typeof Decision.Type

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** The thread counts that must be among the fetched threads. */
interface Counted {
  readonly fetched: number
  readonly replied: number
  readonly unknown: number
  readonly unreplied: number
}

/** Every counted thread is one of the fetched ones. */
export const amongFetched = Schema.makeFilter(
  (threads: Counted) =>
    threads.replied + threads.unreplied + threads.unknown <= threads.fetched ||
    "replied, unreplied and unknown threads must be among the fetched ones",
)

/**
 * Unresolved review threads among the `fetched` ones, by whether the pull request's author
 * answered last. `unknown` threads have a comment in a state this version does not know where
 * their latest submitted comment would be. When `complete` is false, GitHub had more threads, so
 * the counts are lower bounds.
 */
export const Threads = Schema.Struct({
  complete: Schema.Boolean,
  fetched: Count,
  replied: Count,
  unknown: Count,
  unreplied: Count,
}).check(amongFetched)

export interface Threads extends Schema.Schema.Type<typeof Threads> {}

export const Review = Schema.Struct({ decision: Decision, threads: Threads })

export interface Review extends Schema.Schema.Type<typeof Review> {}

export const noReview: Review = {
  decision: "none",
  threads: { complete: true, fetched: 0, replied: 0, unknown: 0, unreplied: 0 },
}

/** GitHub's own decision. It reports none when the base branch requires no review. */
export type ReportedDecision =
  | "approved"
  | "changesRequested"
  | "reviewRequired"
  | "unreported"
  | "unknown"

/**
 * The latest approving, change-requesting or other opinionated review of one writer. `unknown` is
 * a review state this version does not know.
 */
export interface OpinionatedReview {
  readonly verdict: "approved" | "changesRequested" | "other" | "unknown"
  readonly commit: Option.Option<string>
}

export interface ThreadComment {
  /**
   * False for a comment its author has not yet submitted, which only its author can see.
   * `unknown` for a comment state this version does not know.
   */
  readonly submitted: boolean | "unknown"
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

/**
 * Changes requested by any writer win, then a review in an unknown state, which may request
 * changes, then any approval. Review required is never derived.
 */
function derivedDecision(reviews: readonly OpinionatedReview[]): Decision {
  const has = (verdict: OpinionatedReview["verdict"]): boolean =>
    reviews.some((review) => review.verdict === verdict)

  if (has("changesRequested")) return "changesRequested"

  if (has("unknown")) return "unknown"

  return has("approved") ? "approved" : "none"
}

/** Derived only from every writer's review, never from part of them. */
function reportedDecision(evidence: ReviewEvidence): Decision {
  if (evidence.reported === "unreported" && !evidence.moreReviews)
    return derivedDecision(evidence.reviews)

  if (evidence.reported === "unreported") return "none"

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

type Reply = "replied" | "unreplied" | "unknown"

/**
 * Replied when the latest submitted comment is the author's. Unknown when a comment in an unknown
 * state comes after every submitted one, since it may be the latest submitted comment.
 */
function replyOf(thread: ReviewThread, author: Option.Option<string>): Reply {
  const last = Arr.findLast(thread.comments, (comment) => comment.submitted !== false)

  return Option.match(last, {
    onNone: (): Reply => "unreplied",
    onSome: (comment): Reply => {
      if (comment.submitted === "unknown") return "unknown"

      const login = comment.author

      return Option.exists(login, (name) => Option.contains(author, name)) ? "replied" : "unreplied"
    },
  })
}

/** Unresolved threads by their reply; resolved threads are not asked. */
export function threadsOf(evidence: ReviewEvidence): Threads {
  const replies = evidence.threads
    .filter((thread) => !thread.resolved)
    .map((thread) => replyOf(thread, evidence.author))

  const count = (reply: Reply): number => replies.filter((found) => found === reply).length

  return {
    complete: !evidence.moreThreads,
    fetched: evidence.threads.length,
    replied: count("replied"),
    unknown: count("unknown"),
    unreplied: count("unreplied"),
  }
}

export function reviewOf(evidence: ReviewEvidence): Review {
  return { decision: decisionOf(evidence), threads: threadsOf(evidence) }
}
