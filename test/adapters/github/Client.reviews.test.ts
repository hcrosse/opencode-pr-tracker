import { describe, expect, test } from "bun:test"

import { Option, type Schema } from "effect"

import { head, reviewFrom, type ReviewFields as Fields } from "../../support/reviewResponses.ts"

const reviewed = (state: string, oid: string | null): Schema.Json => ({
  commit: oid === null ? null : { oid },
  state,
})

const reviewPage = (hasNextPage: boolean, ...nodes: readonly Schema.Json[]): Schema.Json => ({
  nodes: [...nodes],
  pageInfo: { hasNextPage },
})

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

const decisionFrom = async (fields: Fields): Promise<Option.Option<string>> =>
  Option.map(await reviewFrom(fields), (review) => review.decision)

/** A response with GitHub's `decision` and writers' latest reviews `nodes`. */
const decided = (decision: string | null, ...nodes: readonly Schema.Json[]): Fields => ({
  latestOpinionatedReviews: reviewPage(false, ...nodes),
  reviewDecision: decision,
})

/** As `decided`, with GitHub reporting more writers' reviews than `nodes`. */
const decidedInPart = (decision: string | null, ...nodes: readonly Schema.Json[]): Fields => ({
  latestOpinionatedReviews: reviewPage(true, ...nodes),
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
  ])("reads %s", async (_name, fields, decision) => {
    expect(await decisionFrom(fields)).toEqual(Option.some(decision))
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
  ])("reads %s", async (_name, fields, decision) => {
    expect(await decisionFrom(fields)).toEqual(Option.some(decision))
  })
})

describe("review decision when GitHub has more writers' reviews", () => {
  test.each<readonly [string, Fields, string]>([
    [
      "GitHub's approval, without judging it stale",
      decidedInPart("APPROVED", reviewed("APPROVED", "older")),
      "approved",
    ],
    ["GitHub's change request", decidedInPart("CHANGES_REQUESTED", approval), "changesRequested"],
    [
      "no decision when GitHub reports none",
      decidedInPart(null, reviewed("CHANGES_REQUESTED", head)),
      "none",
    ],
    [
      "no decision when GitHub reports one added later",
      decidedInPart("ESCALATED", approval),
      "none",
    ],
  ])("reads %s", async (_name, fields, decision) => {
    expect(await decisionFrom(fields)).toEqual(Option.some(decision))
  })
})

describe("review threads from a response", () => {
  test("count unresolved threads by the latest submitted comment, ignoring unknown states", async () => {
    const review = await reviewFrom({
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
  test("leaves every thread unreplied when the author's account is gone", async () => {
    const review = await reviewFrom({
      author: null,
      reviewThreads: threadPage(false, thread(false, comment("SUBMITTED", null))),
    })

    expect(Option.map(review, (found) => found.threads)).toEqual(
      Option.some({ complete: true, fetched: 1, replied: 0, unreplied: 1 }),
    )
  })

  test("marks counts as lower bounds when GitHub has more threads", async () => {
    const review = await reviewFrom({ reviewThreads: threadPage(true, thread(true)) })

    expect(Option.map(review, (found) => found.threads)).toEqual(
      Option.some({ complete: false, fetched: 1, replied: 0, unreplied: 0 }),
    )
  })
})
