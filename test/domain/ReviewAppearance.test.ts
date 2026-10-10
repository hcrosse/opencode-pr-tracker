import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import { Option } from "effect"

import { reviewOfStatus, reviewParts, reviewSummary } from "../../src/domain/ReviewAppearance.ts"
import { reviews } from "../support/generators.ts"
import { reviewWith } from "../support/reviews.ts"

describe("review state wording", () => {
  test("shows no review state before the first fetch or after the snapshot is withdrawn", () => {
    expect(reviewOfStatus({ _tag: "Pending" })).toEqual(Option.none())
    expect(reviewOfStatus({ _tag: "Unavailable", diagnostic: "NotFound" })).toEqual(Option.none())
  })

  test("calls exactly one complete thread a thread, and any bound threads", () => {
    expect(reviewSummary(reviewWith("none", [1, 0]))).toEqual(["1 unreplied review thread"])
    expect(reviewSummary(reviewWith("none", [1, 0], false))).toEqual([
      "1+ unreplied review threads",
    ])
    expect(reviewSummary(reviewWith("none", [1, 1]))).toEqual([
      "1 unreplied, 1 replied review threads",
    ])
  })
})

describe("review state properties", () => {
  test("never shows a zero count", () => {
    hegel.test((tc) => {
      const review = tc.draw(reviews)

      tc.note(JSON.stringify(review))

      expect(reviewParts(review).some((part) => part.text.startsWith("0"))).toBe(false)
    })
  })
})

describe("review state thread counts", () => {
  test("every positive count appears in the sidebar and in pr.list", () => {
    hegel.test((tc) => {
      const review = tc.draw(reviews)
      const { complete, replied, unreplied } = review.threads
      const bound = complete ? "" : "+"
      const shown = reviewParts(review).map((part) => part.text)
      const summary = reviewSummary(review).join("; ")

      tc.note(JSON.stringify(review))

      for (const [count, kind] of [
        [unreplied, "unreplied"],
        [replied, "replied"],
      ] as const) {
        if (count > 0) {
          expect(shown).toContain(`${String(count)}${bound} ${kind}`)
          expect(summary).toContain(`${String(count)}${bound} ${kind}`)
        }
      }
    })
  })
})

const nothingUnresolved = reviews.filter(
  (drawn) => drawn.threads.unreplied + drawn.threads.replied === 0,
)

describe("review state without unresolved threads", () => {
  test("shows the fetched threads only when there are more", () => {
    hegel.test((tc) => {
      const review = tc.draw(nothingUnresolved)
      const fetched = `${String(review.threads.fetched)}+`
      const counts = reviewParts(review).filter((part) => /^\d/u.test(part.text))

      tc.note(JSON.stringify(review))

      expect(counts.map((part) => part.text)).toEqual(
        review.threads.complete ? [] : [`${fetched} threads`],
      )
      expect(reviewSummary(review).includes(`${fetched} review threads`)).toBe(
        !review.threads.complete,
      )
    })
  })
})
