import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Option } from "effect"
import { describe, expect, test } from "vitest"

import {
  decisionOf,
  type Decision,
  type OpinionatedReview,
  type ReportedDecision,
  type ReviewEvidence,
} from "../../src/domain/Review.ts"
import { evidence, head, reported } from "../support/reviewEvidence.ts"

/** What writers' latest reviews hold, as far as the decision depends on them. */
type Category =
  | "headApproval"
  | "olderApprovalsOnly"
  | "noApproval"
  | "changeRequest"
  | "changeRequestAndHeadApproval"

const anyCommit = gs.sampledFrom([Option.none<string>(), Option.some(head), Option.some("older")])

const notHead = gs.sampledFrom([Option.none<string>(), Option.some("older")])

const headApproval = gs.just<OpinionatedReview>({ commit: Option.some(head), verdict: "approved" })

const olderApproval = notHead.map((commit): OpinionatedReview => ({ commit, verdict: "approved" }))

const other = anyCommit.map((commit): OpinionatedReview => ({ commit, verdict: "other" }))

const changeRequest = anyCommit.map((commit): OpinionatedReview => ({
  commit,
  verdict: "changesRequested",
}))

/** `required` somewhere among reviews drawn from `rest`. */
const among = (
  required: Readonly<gs.Generator<OpinionatedReview>>,
  rest: Readonly<gs.Generator<OpinionatedReview>>,
): gs.Generator<OpinionatedReview[]> =>
  gs.composite((tc) => {
    const others = tc.draw(gs.arrays(rest, { maxSize: 5 }))
    const at = tc.draw(gs.integers({ maxValue: others.length, minValue: 0 }))

    return [...others.slice(0, at), tc.draw(required), ...others.slice(at)]
  })

/** A change request and an approval of the head commit, among any other reviews. */
const changeRequestAndHeadApproval = gs.composite((tc) => {
  const reviews = tc.draw(
    among(changeRequest, gs.oneOf(changeRequest, headApproval, olderApproval, other)),
  )

  const at = tc.draw(gs.integers({ maxValue: reviews.length, minValue: 0 }))

  return [...reviews.slice(0, at), tc.draw(headApproval), ...reviews.slice(at)]
})

/** `changeRequest` sits beside approvals of older commits only; the mixed category adds the head. */
const categories: Readonly<Record<Category, gs.Generator<OpinionatedReview[]>>> = {
  changeRequest: among(changeRequest, gs.oneOf(changeRequest, olderApproval, other)),
  changeRequestAndHeadApproval,
  headApproval: among(headApproval, gs.oneOf(headApproval, olderApproval, other)),
  noApproval: gs.arrays(other, { maxSize: 5 }),
  olderApprovalsOnly: among(olderApproval, gs.oneOf(olderApproval, other)),
}

/** The decision with every writer's review, by what they hold and what GitHub reported. */
const complete: Readonly<Record<Category, Readonly<Record<ReportedDecision, Decision>>>> = {
  changeRequest: {
    approved: "staleApproval",
    changesRequested: "changesRequested",
    reviewRequired: "reviewRequired",
    unknown: "unknown",
    unreported: "changesRequested",
  },
  changeRequestAndHeadApproval: {
    approved: "approved",
    changesRequested: "changesRequested",
    reviewRequired: "reviewRequired",
    unknown: "unknown",
    unreported: "changesRequested",
  },
  headApproval: {
    approved: "approved",
    changesRequested: "changesRequested",
    reviewRequired: "reviewRequired",
    unknown: "unknown",
    unreported: "approved",
  },
  noApproval: {
    approved: "staleApproval",
    changesRequested: "changesRequested",
    reviewRequired: "reviewRequired",
    unknown: "unknown",
    unreported: "none",
  },
  olderApprovalsOnly: {
    approved: "staleApproval",
    changesRequested: "changesRequested",
    reviewRequired: "reviewRequired",
    unknown: "unknown",
    unreported: "staleApproval",
  },
}

/** Without every writer's review, whatever they hold: GitHub's own decision, never derived. */
const partial: Readonly<Record<ReportedDecision, Decision>> = {
  approved: "approved",
  changesRequested: "changesRequested",
  reviewRequired: "reviewRequired",
  unknown: "unknown",
  unreported: "none",
}

const categoryNames = gs.sampledFrom<Category>([
  "changeRequest",
  "changeRequestAndHeadApproval",
  "headApproval",
  "noApproval",
  "olderApprovalsOnly",
])

interface Drawn {
  readonly category: Category
  readonly found: ReviewEvidence
}

const drawn = (moreReviews: boolean): gs.Generator<Drawn> =>
  gs.composite((tc) => {
    const category = tc.draw(categoryNames)

    const found = tc.draw(
      evidence({ moreReviews: gs.just(moreReviews), reported, reviews: categories[category] }),
    )

    tc.note(JSON.stringify({ category, found }))

    return { category, found }
  })

describe("review decision", () => {
  test("with every writer's review, follows GitHub or the reviews", () => {
    hegel.test((tc) => {
      const { category, found } = tc.draw(drawn(false))

      expect(decisionOf(found)).toBe(complete[category][found.reported])
    })
  })

  test("without every writer's review, is GitHub's own decision", () => {
    hegel.test((tc) => {
      const { found } = tc.draw(drawn(true))

      expect(decisionOf(found)).toBe(partial[found.reported])
    })
  })
})

const evidenceOf = (
  decision: ReportedDecision,
  review: OpinionatedReview,
  moreReviews: boolean,
): ReviewEvidence => ({
  author: Option.some("author"),
  head,
  moreReviews,
  moreThreads: false,
  reported: decision,
  reviews: [review],
  threads: [],
})

const approvalOfOlder: OpinionatedReview = { commit: Option.some("older"), verdict: "approved" }

const requestOfHead: OpinionatedReview = { commit: Option.some(head), verdict: "changesRequested" }

describe("review decision with and without every writer's review", () => {
  test.each<readonly [string, ReviewEvidence, Decision]>([
    [
      "an approval of an older commit, all reviews",
      evidenceOf("approved", approvalOfOlder, false),
      "staleApproval",
    ],
    [
      "an approval of an older commit, part of the reviews",
      evidenceOf("approved", approvalOfOlder, true),
      "approved",
    ],
    [
      "no decision with a change request, all reviews",
      evidenceOf("unreported", requestOfHead, false),
      "changesRequested",
    ],
    [
      "no decision with a change request, part of the reviews",
      evidenceOf("unreported", requestOfHead, true),
      "none",
    ],
  ])("reads %s", (_name, found, decision) => {
    expect(decisionOf(found)).toBe(decision)
  })
})

const unknownOfHead: OpinionatedReview = { commit: Option.some(head), verdict: "unknown" }

const headApprovalReview: OpinionatedReview = { commit: Option.some(head), verdict: "approved" }

describe("review decision derived beside a review in an unknown state", () => {
  test.each<readonly [string, readonly OpinionatedReview[], Decision]>([
    ["alone", [unknownOfHead], "unknown"],
    ["beside an approval of the head", [headApprovalReview, unknownOfHead], "unknown"],
    ["beside a change request", [unknownOfHead, requestOfHead], "changesRequested"],
  ])("reads one %s", (_name, reviews, decision) => {
    const found: ReviewEvidence = {
      author: Option.some("author"),
      head,
      moreReviews: false,
      moreThreads: false,
      reported: "unreported",
      reviews,
      threads: [],
    }

    expect(decisionOf(found)).toBe(decision)
  })
})
