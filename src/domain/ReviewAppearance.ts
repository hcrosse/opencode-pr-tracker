import { Option } from "effect"

import type { Tone } from "./Appearance.ts"
import type { Decision, Review, Threads } from "./Review.ts"
import type { Status } from "./Snapshot.ts"

/** One part of the review state as the sidebar shows it. */
export interface ReviewPart {
  readonly text: string
  readonly tone: Tone
}

interface DecisionWords {
  readonly short: string
  readonly long: string
  readonly tone: Tone
}

const decisionWords: Record<Exclude<Decision, "none">, DecisionWords> = {
  approved: { long: "approved", short: "approved", tone: "green" },
  changesRequested: { long: "changes requested", short: "changes", tone: "yellow" },
  reviewRequired: { long: "review required", short: "review", tone: "gray" },
  staleApproval: { long: "stale approval", short: "stale approval", tone: "yellow" },
  unknown: { long: "review decision unknown", short: "review unknown", tone: "gray" },
}

/** A count of unresolved threads; `seen` counts threads when none fetched are unresolved. */
interface ThreadCount {
  readonly count: string
  readonly kind: "unreplied" | "replied" | "unknown" | "seen"
}

const toneOfKind: Record<ThreadCount["kind"], Tone> = {
  replied: "gray",
  seen: "gray",
  unknown: "gray",
  unreplied: "yellow",
}

function threadCounts(threads: Threads): readonly ThreadCount[] {
  const bound = threads.complete ? "" : "+"

  const counts = (["unreplied", "replied", "unknown"] as const).flatMap((kind): ThreadCount[] =>
    threads[kind] > 0 ? [{ count: `${String(threads[kind])}${bound}`, kind }] : [],
  )

  return counts.length === 0 && !threads.complete
    ? [{ count: `${String(threads.fetched)}+`, kind: "seen" }]
    : counts
}

const decisionOf = (review: Review): Option.Option<DecisionWords> =>
  review.decision === "none" ? Option.none() : Option.some(decisionWords[review.decision])

/** The review state of an open pull request GitHub has reported, current or stale. */
export function reviewOfStatus(status: Status): Option.Option<Review> {
  if (status._tag !== "Fresh" && status._tag !== "Stale") return Option.none()

  const { state } = status.snapshot

  return state._tag === "Open" ? Option.some(state.review) : Option.none()
}

/** The sidebar's words: a short decision, then unreplied and replied thread counts. */
export function reviewParts(review: Review): readonly ReviewPart[] {
  const decision = Option.match(decisionOf(review), {
    onNone: (): readonly ReviewPart[] => [],
    onSome: (words) => [{ text: words.short, tone: words.tone }],
  })

  const threads = threadCounts(review.threads).map((part) => ({
    text: part.kind === "seen" ? `${part.count} threads` : `${part.count} ${part.kind}`,
    tone: toneOfKind[part.kind],
  }))

  return [...decision, ...threads]
}

/** The review state in words, such as `changes requested` and `2 unreplied, 1 replied review threads`. */
export function reviewSummary(review: Review): readonly string[] {
  const decision = Option.toArray(Option.map(decisionOf(review), (words) => words.long))
  const counts = threadCounts(review.threads)
  const total = review.threads.unreplied + review.threads.replied + review.threads.unknown
  const noun = review.threads.complete && total === 1 ? "review thread" : "review threads"

  const phrase = counts
    .map((part) => (part.kind === "seen" ? part.count : `${part.count} ${part.kind}`))
    .join(", ")

  return counts.length === 0 ? decision : [...decision, `${phrase} ${noun}`]
}
