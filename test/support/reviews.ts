import type { Tone } from "../../src/domain/Appearance.ts"
import type { Decision, Review } from "../../src/domain/Review.ts"
import type { Ci, PullRequestState } from "../../src/domain/Snapshot.ts"

/** One row of the review state design examples: what the sidebar and `pr.list` show. */
export interface ReviewExample {
  readonly name: string
  readonly number: number
  readonly state: PullRequestState
  readonly stale: boolean
  readonly parts: readonly (readonly [string, Tone])[]
  readonly list: string
}

export const reviewWith = (
  decision: Decision,
  [unreplied, replied]: readonly [number, number] = [0, 0],
  complete = true,
): Review => ({
  decision,
  threads: { complete, fetched: complete ? unreplied + replied : 20, replied, unreplied },
})

const open = (ci: Ci, review: Review, draft = false): PullRequestState => ({
  _tag: "Open",
  behind: false,
  ci,
  draft,
  mergeability: "mergeable",
  review,
})

type Shown = readonly [parts: readonly (readonly [string, Tone])[], list: string]

const example = (
  name: string,
  [number, state]: readonly [number, PullRequestState],
  [parts, list]: Shown,
): ReviewExample => ({ list, name, number, parts, stale: false, state })

export const reviewExamples: readonly ReviewExample[] = [
  example(
    "approved of the head commit",
    [12, open("passed", reviewWith("approved"))],
    [[["approved", "green"]], "(passed; approved)"],
  ),
  example(
    "approved before the latest push",
    [12, open("passed", reviewWith("staleApproval"))],
    [[["stale approval", "yellow"]], "(passed; stale approval)"],
  ),
  example(
    "changes requested, with mixed threads",
    [13, open("pending", reviewWith("changesRequested", [2, 1]))],
    [
      [
        ["changes", "yellow"],
        ["2 unreplied", "yellow"],
        ["1 replied", "gray"],
      ],
      "(pending; changes requested; 2 unreplied, 1 replied review threads)",
    ],
  ),
  example(
    "review required, with one thread awaiting the author",
    [14, open("passed", reviewWith("reviewRequired", [1, 0]))],
    [
      [
        ["review", "gray"],
        ["1 unreplied", "yellow"],
      ],
      "(passed; review required; 1 unreplied review thread)",
    ],
  ),
  example(
    "no decision, with one replied thread",
    [42, open("passed", reviewWith("none", [0, 1]))],
    [[["1 replied", "gray"]], "(passed; 1 replied review thread)"],
  ),
  example(
    "failing CI with an approval",
    [40, open("failed", reviewWith("approved", [3, 0]))],
    [
      [
        ["approved", "green"],
        ["3 unreplied", "yellow"],
      ],
      "(failed; approved; 3 unreplied review threads)",
    ],
  ),
  example(
    "a draft",
    [41, open("passed", reviewWith("none", [2, 0]), true)],
    [[["2 unreplied", "yellow"]], "(draft; 2 unreplied review threads)"],
  ),
  example(
    "more than 20 threads",
    [17, open("pending", reviewWith("changesRequested", [12, 3], false))],
    [
      [
        ["changes", "yellow"],
        ["12+ unreplied", "yellow"],
        ["3+ replied", "gray"],
      ],
      "(pending; changes requested; 12+ unreplied, 3+ replied review threads)",
    ],
  ),
  example(
    "more than 20 threads, none of the first 20 unresolved",
    [18, open("passed", reviewWith("none", [0, 0], false))],
    [[["20+ threads", "gray"]], "(passed; 20+ review threads)"],
  ),
  {
    list: "(pending; changes requested; 2 unreplied review threads)",
    name: "a failing refresh",
    number: 13,
    parts: [
      ["changes", "yellow"],
      ["2 unreplied", "yellow"],
    ],
    stale: true,
    state: open("pending", reviewWith("changesRequested", [2, 0])),
  },
  example("merged", [10, { _tag: "Merged" }], [[], "(merged)"]),
]
