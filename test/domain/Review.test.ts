import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Option } from "effect"
import { describe, expect, test } from "vitest"

import { threadsOf, type ReviewEvidence, type ReviewThread } from "../../src/domain/Review.ts"
import { author, comments, evidence, threads, withThreads } from "../support/reviewEvidence.ts"

const counts = (found: ReviewEvidence): readonly number[] => {
  const counted = threadsOf(found)

  return [counted.unreplied, counted.replied, counted.unknown]
}

const unresolvedCount = (found: ReviewEvidence): number =>
  found.threads.filter((thread) => !thread.resolved).length

describe("review thread counts", () => {
  test("count every unresolved thread once, complete only when GitHub had no more", () => {
    hegel.test((tc) => {
      const found = tc.draw(evidence())
      const counted = threadsOf(found)

      tc.note(JSON.stringify(found))

      expect(counted.unreplied + counted.replied + counted.unknown).toBe(unresolvedCount(found))
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
})

describe("review thread replies in an unknown state", () => {
  test("a comment in an unknown state after every submitted one makes the thread unknown", () => {
    hegel.test((tc) => {
      const found = tc.draw(evidence())
      const thread = tc.draw(threads(gs.just(false)))
      const unclear = { author: tc.draw(comments).author, submitted: "unknown" as const }
      const latest = { comments: [...thread.comments, unclear], resolved: false }
      const after = threadsOf(withThreads(found, [...found.threads, latest]))

      expect([after.unreplied, after.replied, after.unknown]).toEqual([
        threadsOf(found).unreplied,
        threadsOf(found).replied,
        threadsOf(found).unknown + 1,
      ])
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
