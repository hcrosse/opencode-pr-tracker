import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Option } from "effect"

import {
  decisionOf,
  type Decision,
  type OpinionatedReview,
  type ReportedDecision,
  type ReviewEvidence,
} from "../../src/domain/Review.ts"
import { evidence, head } from "../support/reviewEvidence.ts"

/** The decision GitHub reported, or none when it reported none or one added later. */
const reportedOnly = (reported: ReportedDecision): Decision =>
  reported === "unreported" || reported === "unrecognized" ? "none" : reported

describe("review decision without every writer's review", () => {
  test("is GitHub's own decision, never derived and never a stale approval", () => {
    hegel.test((tc) => {
      const found = tc.draw(evidence({ moreReviews: gs.just(true) }))
      const decision = decisionOf(found)

      tc.note(JSON.stringify(found))

      expect(decision).toBe(reportedOnly(found.reported))
      expect(decision).not.toBe("staleApproval")
    })
  })
})

const olderApproval: OpinionatedReview = { commit: Option.some("older"), verdict: "approved" }

const changeRequest: OpinionatedReview = { commit: Option.some(head), verdict: "changesRequested" }

const evidenceOf = (
  reported: ReportedDecision,
  review: OpinionatedReview,
  moreReviews: boolean,
): ReviewEvidence => ({
  author: Option.some("author"),
  head,
  moreReviews,
  moreThreads: false,
  reported,
  reviews: [review],
  threads: [],
})

describe("review decision with and without every writer's review", () => {
  test.each<readonly [string, ReviewEvidence, Decision]>([
    [
      "an approval of an older commit, all reviews",
      evidenceOf("approved", olderApproval, false),
      "staleApproval",
    ],
    [
      "an approval of an older commit, part of the reviews",
      evidenceOf("approved", olderApproval, true),
      "approved",
    ],
    [
      "no decision with a change request, all reviews",
      evidenceOf("unreported", changeRequest, false),
      "changesRequested",
    ],
    [
      "no decision with a change request, part of the reviews",
      evidenceOf("unreported", changeRequest, true),
      "none",
    ],
  ])("reads %s", (_name, found, decision) => {
    expect(decisionOf(found)).toBe(decision)
  })
})
