import { describe, expect, test } from "bun:test"

import { Option, Schema } from "effect"

import { PullRequestNode, toReport } from "../../../src/adapters/github/Response.ts"
import type { Review } from "../../../src/domain/Review.ts"
import { recordedNode, tracker127 } from "../../support/github.ts"

const head = "5248a25"

interface Fields {
  readonly reviewDecision?: string | null
  readonly author?: { readonly login: string } | null
  readonly latestOpinionatedReviews?: Schema.Json
  readonly reviewThreads?: Schema.Json
}

const decode = Schema.decodeUnknownOption(PullRequestNode)

/** The review state parsed from the recorded #127 response with `fields` replaced. */
function reviewFrom(fields: Fields): Option.Option<Review> {
  const raw = Object.assign({}, recordedNode("standalone", "pr0"), { headRefOid: head }, fields)

  return Option.flatMap(decode(raw), (node) => {
    const { state } = toReport(tracker127, node, []).snapshot

    return state._tag === "Open" ? Option.some(state.review) : Option.none()
  })
}

const reviewed = (state: string, oid: string | null): Schema.Json => ({
  commit: oid === null ? null : { oid },
  state,
})

const reviews = (...nodes: readonly Schema.Json[]): Schema.Json => ({ nodes: [...nodes] })

const comment = (state: string, login: string | null): Schema.Json => ({
  author: login === null ? null : { login },
  state,
})

const thread = (isResolved: boolean, ...comments: readonly Schema.Json[]): Schema.Json => ({
  comments: { nodes: [...comments] },
  isResolved,
})

const threadPage = (hasNextPage: boolean, ...nodes: readonly Schema.Json[]): Schema.Json => ({
  nodes: [...nodes],
  pageInfo: { hasNextPage },
})

const decisionFrom = (fields: Fields): Option.Option<string> =>
  Option.map(reviewFrom(fields), (review) => review.decision)

/** A response with GitHub's `decision` and writers' latest reviews `nodes`. */
const decided = (decision: string | null, ...nodes: readonly Schema.Json[]): Fields => ({
  latestOpinionatedReviews: reviews(...nodes),
  reviewDecision: decision,
})

const approval = reviewed("APPROVED", head)

describe("review decision GitHub reports", () => {
  test.each<readonly [string, Fields, string]>([
    ["an approval of the head commit", decided("APPROVED", approval), "approved"],
    [
      "an approval of an older commit",
      decided("APPROVED", reviewed("APPROVED", "older")),
      "staleApproval",
    ],
    ["review required", decided("REVIEW_REQUIRED"), "reviewRequired"],
    ["a decision GitHub added later", decided("ESCALATED", approval), "none"],
  ])("reads %s", (_name, fields, decision) => {
    expect(decisionFrom(fields)).toEqual(Option.some(decision))
  })
})

describe("review decision derived when GitHub reports none", () => {
  test.each<readonly [string, Fields, string]>([
    ["an approval of the head commit", decided(null, approval), "approved"],
    [
      "an approval of a commit GitHub no longer has",
      decided(null, reviewed("APPROVED", null)),
      "staleApproval",
    ],
    [
      "changes requested beside an approval",
      decided(null, approval, reviewed("CHANGES_REQUESTED", head)),
      "changesRequested",
    ],
    ["a review state GitHub added later", decided(null, reviewed("DISMISSED", head)), "none"],
  ])("reads %s", (_name, fields, decision) => {
    expect(decisionFrom(fields)).toEqual(Option.some(decision))
  })
})

describe("review threads from a response", () => {
  test("count unresolved threads by the latest submitted comment, ignoring unknown states", () => {
    const review = reviewFrom({
      author: { login: "hcrosse" },
      reviewThreads: threadPage(
        false,
        thread(false, comment("SUBMITTED", "reviewer"), comment("SUBMITTED", "hcrosse")),
        thread(false, comment("SUBMITTED", "reviewer"), comment("PENDING", "hcrosse")),
        thread(false, comment("SUBMITTED", "hcrosse"), comment("SUBMITTED", null)),
        thread(false, comment("SUBMITTED", "hcrosse"), comment("SOMETHING_NEW", "reviewer")),
        thread(true, comment("SUBMITTED", "reviewer")),
      ),
    })

    expect(review).toEqual(
      Option.some({
        decision: "none",
        threads: { complete: true, fetched: 5, replied: 2, unreplied: 2 },
      }),
    )
  })
})

describe("review threads from a response with missing data", () => {
  test("leaves every thread unreplied when the author's account is gone", () => {
    const review = reviewFrom({
      author: null,
      reviewThreads: threadPage(false, thread(false, comment("SUBMITTED", null))),
    })

    expect(Option.map(review, (found) => found.threads)).toEqual(
      Option.some({ complete: true, fetched: 1, replied: 0, unreplied: 1 }),
    )
  })

  test("marks counts as lower bounds when GitHub has more threads", () => {
    const review = reviewFrom({ reviewThreads: threadPage(true, thread(true)) })

    expect(Option.map(review, (found) => found.threads)).toEqual(
      Option.some({ complete: false, fetched: 1, replied: 0, unreplied: 0 }),
    )
  })
})
