import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Option } from "effect"

import {
  decisionOf,
  threadsOf,
  type Decision,
  type OpinionatedReview,
  type ReportedDecision,
  type ReviewEvidence,
  type ReviewThread,
} from "../../src/domain/Review.ts"
import {
  author,
  comments,
  evidence,
  head,
  opinionatedReviews,
  threads,
  withThreads,
} from "../support/reviewEvidence.ts"

const approvesHead = (reviews: readonly OpinionatedReview[]): boolean =>
  reviews.some((review) => review.verdict === "approved" && Option.contains(review.commit, head))

const reportedByGitHub = gs.sampledFrom<Decision & ReportedDecision>([
  "approved",
  "changesRequested",
  "reviewRequired",
])

/** Writers' reviews with a change request among them. */
const withChangeRequest: gs.Generator<OpinionatedReview[]> = gs.composite((tc) => {
  const others = tc.draw(gs.arrays(opinionatedReviews, { maxSize: 5 }))
  const request = tc.draw(opinionatedReviews)
  const at = tc.draw(gs.integers({ maxValue: others.length, minValue: 0 }))
  const changes: OpinionatedReview = { commit: request.commit, verdict: "changesRequested" }

  return [...others.slice(0, at), changes, ...others.slice(at)]
})

describe("review decision reported by GitHub", () => {
  test("is kept, except an approval without an approval of the head commit", () => {
    hegel.test((tc) => {
      const reported = tc.draw(reportedByGitHub)
      const found = tc.draw(evidence({ reported: gs.just(reported) }))
      const stale = reported === "approved" && !approvesHead(found.reviews)

      tc.note(JSON.stringify(found))

      expect(decisionOf(found)).toBe(stale ? "staleApproval" : reported)
    })
  })

  test("shows as no decision when GitHub adds a new one", () => {
    hegel.test((tc) => {
      expect(decisionOf(tc.draw(evidence({ reported: gs.just("unrecognized") })))).toBe("none")
    })
  })
})

describe("review decision derived when GitHub reports none", () => {
  test("is changes requested when any writer requested changes", () => {
    hegel.test((tc) => {
      const reviews = gs.just(tc.draw(withChangeRequest))
      const found = tc.draw(evidence({ reported: gs.just("unreported"), reviews }))

      expect(decisionOf(found)).toBe("changesRequested")
    })
  })

  test("is never review required, is none without an opinion, and approves only the head", () => {
    hegel.test((tc) => {
      const found = tc.draw(evidence({ reported: gs.just("unreported") }))
      const decision = decisionOf(found)
      const verdicts = new Set(found.reviews.map((review) => review.verdict))
      const opinionated = verdicts.has("approved") || verdicts.has("changesRequested")

      tc.note(JSON.stringify(found))

      expect(decision).not.toBe("reviewRequired")
      expect(decision === "none").toBe(!opinionated)
      expect(decision === "approved" && !approvesHead(found.reviews)).toBe(false)
    })
  })
})

const counts = (found: ReviewEvidence): readonly number[] => {
  const counted = threadsOf(found)

  return [counted.unreplied, counted.replied]
}

const unresolvedCount = (found: ReviewEvidence): number =>
  found.threads.filter((thread) => !thread.resolved).length

describe("review thread counts", () => {
  test("count every unresolved thread once, complete only when GitHub had no more", () => {
    hegel.test((tc) => {
      const found = tc.draw(evidence())
      const counted = threadsOf(found)

      tc.note(JSON.stringify(found))

      expect(counted.unreplied + counted.replied).toBe(unresolvedCount(found))
      expect(counted.fetched).toBe(found.threads.length)
      expect(counted.complete).toBe(!found.moreThreads)
    })
  })

  test("never include resolved threads", () => {
    hegel.test((tc) => {
      const found = tc.draw(evidence())
      const resolved = tc.draw(gs.arrays(threads(gs.just(true)), { maxSize: 5 }))

      expect(counts(withThreads(found, [...found.threads, ...resolved]))).toEqual(counts(found))
    })
  })

  test("include no replied thread when the pull request's author is unknown", () => {
    hegel.test((tc) => {
      expect(threadsOf(tc.draw(evidence({ author: gs.just(Option.none()) }))).replied).toBe(0)
    })
  })
})

/** The thread with an unsubmitted comment inserted at `at`. */
const withPending = (
  thread: ReviewThread,
  at: number,
  login: Option.Option<string>,
): ReviewThread => ({
  comments: [
    ...thread.comments.slice(0, at),
    { author: login, submitted: false },
    ...thread.comments.slice(at),
  ],
  resolved: thread.resolved,
})

describe("review thread replies", () => {
  test("the author submitting the latest comment of an unresolved thread makes it replied", () => {
    hegel.test((tc) => {
      const found = tc.draw(evidence())
      const thread = tc.draw(threads(gs.just(false)))
      const reply = { author: Option.some(author), submitted: true }
      const answered = { comments: [...thread.comments, reply], resolved: false }
      const after = threadsOf(withThreads(found, [...found.threads, answered]))

      expect(after.replied).toBe(threadsOf(found).replied + 1)
      expect(after.unreplied).toBe(threadsOf(found).unreplied)
    })
  })

  test("unsubmitted comments never change a thread's classification", () => {
    hegel.test((tc) => {
      const found = tc.draw(evidence())
      const last = Math.max(0, found.threads.length - 1)
      const index = tc.draw(gs.integers({ maxValue: last, minValue: 0 }))
      const login = tc.draw(comments).author
      const at = tc.draw(gs.integers({ maxValue: 5, minValue: 0 }))

      const changed = found.threads.map((thread, position) =>
        position === index ? withPending(thread, at, login) : thread,
      )

      expect(threadsOf(withThreads(found, changed))).toEqual(threadsOf(found))
    })
  })
})
