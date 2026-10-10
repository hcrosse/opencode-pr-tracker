import { Option, Schema, SchemaGetter } from "effect"

import {
  noReview,
  Review,
  reviewOf,
  type OpinionatedReview,
  type ReportedDecision,
  type ReviewEvidence,
  type ReviewMode,
  type ReviewThread,
} from "../../domain/Review.ts"
import { enumeration, Unrecognized, unrecognizedAmong } from "./Enumeration.ts"

const Author = Schema.NullOr(Schema.Struct({ login: Schema.String }))

const ReviewState = enumeration("PullRequestReview.state", [
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
])

const CommentState = enumeration("PullRequestReviewComment.state", ["PENDING", "SUBMITTED"])

const ReviewDecision = enumeration("PullRequest.reviewDecision", [
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
])

const ReviewNode = Schema.Struct({
  commit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
  state: ReviewState,
})

const CommentNode = Schema.Struct({ author: Author, state: CommentState })

const ThreadNode = Schema.Struct({
  comments: Schema.Struct({ nodes: Schema.Array(CommentNode) }),
  isResolved: Schema.Boolean,
})

/**
 * The review fields of a pull request node. A value GitHub adds later to an enumeration reads as
 * unknown rather than failing the whole pull request.
 */
const ReviewFields = Schema.Struct({
  author: Author,
  headRefOid: Schema.String,
  latestOpinionatedReviews: Schema.Struct({
    nodes: Schema.Array(ReviewNode),
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
  }),
  reviewDecision: Schema.NullOr(ReviewDecision),
  reviewThreads: Schema.Struct({
    nodes: Schema.Array(ThreadNode),
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
  }),
})

interface ReviewFields extends Schema.Schema.Type<typeof ReviewFields> {}

interface ReviewNode extends Schema.Schema.Type<typeof ReviewNode> {}

interface ThreadNode extends Schema.Schema.Type<typeof ThreadNode> {}

const reportedDecisions: Readonly<
  Record<(typeof ReviewDecision.members)[0]["Type"], ReportedDecision>
> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changesRequested",
  REVIEW_REQUIRED: "reviewRequired",
}

const verdicts: Readonly<
  Record<(typeof ReviewState.members)[0]["Type"], OpinionatedReview["verdict"]>
> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changesRequested",
  COMMENTED: "other",
  DISMISSED: "other",
  PENDING: "other",
}

function reportedOf(decision: ReviewFields["reviewDecision"]): ReportedDecision {
  if (decision === null) return "unreported"

  return decision instanceof Unrecognized ? "unknown" : reportedDecisions[decision]
}

const loginOf = (author: ReviewFields["author"]): Option.Option<string> =>
  Option.map(Option.fromNullishOr(author), (found) => found.login)

const toReview = (node: ReviewNode): OpinionatedReview => ({
  commit: Option.map(Option.fromNullishOr(node.commit), (commit) => commit.oid),
  verdict: node.state instanceof Unrecognized ? "unknown" : verdicts[node.state],
})

const toThread = (node: ThreadNode): ReviewThread => ({
  comments: node.comments.nodes.map((comment) => ({
    author: loginOf(comment.author),
    submitted: comment.state instanceof Unrecognized ? "unknown" : comment.state === "SUBMITTED",
  })),
  resolved: node.isResolved,
})

export function toReviewEvidence(node: ReviewFields): ReviewEvidence {
  return {
    author: loginOf(node.author),
    head: node.headRefOid,
    moreReviews: node.latestOpinionatedReviews.pageInfo.hasNextPage,
    moreThreads: node.reviewThreads.pageInfo.hasNextPage,
    reported: reportedOf(node.reviewDecision),
    reviews: node.latestOpinionatedReviews.nodes.map((review) => toReview(review)),
    threads: node.reviewThreads.nodes.map((thread) => toThread(thread)),
  }
}

/** The enumeration values in a pull request's review fields this version does not know. */
const unrecognizedIn = (node: ReviewFields): Unrecognized[] =>
  unrecognizedAmong([
    node.reviewDecision,
    ...node.latestOpinionatedReviews.nodes.map((review) => review.state),
    ...node.reviewThreads.nodes.flatMap((thread) =>
      thread.comments.nodes.map((comment) => comment.state),
    ),
  ])

/** A pull request's review state, and the values in its review fields this version does not know. */
const ReadReview = Schema.Struct({ review: Review, unrecognized: Schema.Array(Unrecognized) })

export interface ReadReview extends Schema.Schema.Type<typeof ReadReview> {}

const notSent = SchemaGetter.forbidden<never, ReadReview>(
  () => "Review state is never sent to GitHub",
)

const FetchedReview = ReviewFields.pipe(
  Schema.decodeTo(ReadReview, {
    decode: SchemaGetter.transform((fields: ReviewFields) => ({
      review: reviewOf(toReviewEvidence(fields)),
      unrecognized: unrecognizedIn(fields),
    })),
    encode: notSent,
  }),
)

const NoReview = Schema.Unknown.pipe(
  Schema.decodeTo(ReadReview, {
    decode: SchemaGetter.transform(() => ({ review: noReview, unrecognized: [] })),
    encode: notSent,
  }),
)

/**
 * How each mode reads the review state from a pull request's response node. "off" reads none of
 * its review fields; "all" needs every one of them.
 */
export const reviewStates: Readonly<Record<ReviewMode, Schema.Decoder<ReadReview>>> = {
  all: FetchedReview,
  off: NoReview,
}
