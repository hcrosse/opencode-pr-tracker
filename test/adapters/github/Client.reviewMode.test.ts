import { describe, expect, test } from "bun:test"

import { Option } from "effect"

import { batch } from "../../../src/adapters/github/Query.ts"
import { noReview } from "../../../src/domain/Review.ts"
import { ItemResult } from "../../../src/ports/GitHub.ts"
import { fetch127, reviewOfResult } from "../../support/reviewResponses.ts"

const reviewFields = [
  "headRefOid",
  "author",
  "reviewDecision",
  "latestOpinionatedReviews",
  "reviewThreads",
]

const asked = (query: string): readonly string[] =>
  reviewFields.filter((field) => query.includes(field))

describe("review state off", () => {
  test("asks GitHub for no review field", async () => {
    const { query } = await fetch127({}, "off")

    expect(query).toContain("mergeStateStatus")
    expect(asked(query)).toEqual([])
    expect(asked(batch(5, "off"))).toEqual([])
  })

  test("reports no review state, even when the response has review fields", async () => {
    const { result } = await fetch127({ reviewDecision: "CHANGES_REQUESTED" }, "off")

    expect(reviewOfResult(result)).toEqual(Option.some(noReview))
  })

  test("ignores malformed review fields", async () => {
    const { result } = await fetch127({ reviewThreads: null }, "off")

    expect(reviewOfResult(result)).toEqual(Option.some(noReview))
  })
})

describe("review state on", () => {
  test("asks GitHub for every review field", async () => {
    const { query } = await fetch127({}, "all")

    expect(asked(query)).toEqual(reviewFields)
  })

  test("reports the review state", async () => {
    const { result } = await fetch127({ reviewDecision: "CHANGES_REQUESTED" }, "all")

    expect(Option.map(reviewOfResult(result), (review) => review.decision)).toEqual(
      Option.some("changesRequested"),
    )
  })

  test("fails a pull request whose review fields GitHub did not return", async () => {
    const { result } = await fetch127({ reviewThreads: null }, "all")

    expect(result).toEqual(
      Option.some(ItemResult.Failed({ charged: false, diagnostic: "InvalidResponse" })),
    )
  })
})
