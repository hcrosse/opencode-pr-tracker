import { Option, Schema } from "effect"

import type {
  OpinionatedReview,
  ReportedDecision,
  ReviewEvidence,
  ReviewThread,
} from "../../domain/Review.ts"

const Author = Schema.NullOr(Schema.Struct({ login: Schema.String }))

const ReviewNode = Schema.Struct({
  commit: Schema.NullOr(Schema.Struct({ oid: Schema.String })),
  state: Schema.String,
})

const CommentNode = Schema.Struct({ author: Author, state: Schema.String })

const ThreadNode = Schema.Struct({
  comments: Schema.Struct({ nodes: Schema.Array(CommentNode) }),
  isResolved: Schema.Boolean,
})

/**
 * The review fields of a pull request node. Enumerations are read as text, so a value GitHub adds
 * later cannot fail the whole pull request.
 */
export const reviewFields = {
  author: Author,
  headRefOid: Schema.String,
  latestOpinionatedReviews: Schema.Struct({ nodes: Schema.Array(ReviewNode) }),
  reviewDecision: Schema.NullOr(Schema.String),
  reviewThreads: Schema.Struct({
    nodes: Schema.Array(ThreadNode),
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
  }),
}

const ReviewFields = Schema.Struct(reviewFields)

type ReviewFields = typeof ReviewFields.Type

type ReviewNode = typeof ReviewNode.Type

type ThreadNode = typeof ThreadNode.Type

const reportedDecisions: ReadonlyMap<string, ReportedDecision> = new Map([
  ["APPROVED", "approved"],
  ["CHANGES_REQUESTED", "changesRequested"],
  ["REVIEW_REQUIRED", "reviewRequired"],
])

const verdicts: ReadonlyMap<string, OpinionatedReview["verdict"]> = new Map([
  ["APPROVED", "approved"],
  ["CHANGES_REQUESTED", "changesRequested"],
])

function reportedOf(decision: string | null): ReportedDecision {
  if (decision === null) return "unreported"

  return reportedDecisions.get(decision) ?? "unrecognized"
}

const loginOf = (author: ReviewFields["author"]): Option.Option<string> =>
  Option.map(Option.fromNullishOr(author), (found) => found.login)

const toReview = (node: ReviewNode): OpinionatedReview => ({
  commit: Option.map(Option.fromNullishOr(node.commit), (commit) => commit.oid),
  verdict: verdicts.get(node.state) ?? "other",
})

const toThread = (node: ThreadNode): ReviewThread => ({
  comments: node.comments.nodes.map((comment) => ({
    author: loginOf(comment.author),
    submitted: comment.state === "SUBMITTED",
  })),
  resolved: node.isResolved,
})

export function toReviewEvidence(node: ReviewFields): ReviewEvidence {
  return {
    author: loginOf(node.author),
    head: node.headRefOid,
    moreThreads: node.reviewThreads.pageInfo.hasNextPage,
    reported: reportedOf(node.reviewDecision),
    reviews: node.latestOpinionatedReviews.nodes.map((review) => toReview(review)),
    threads: node.reviewThreads.nodes.map((thread) => toThread(thread)),
  }
}
