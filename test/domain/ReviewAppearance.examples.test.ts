import { Option } from "effect"
import { describe, expect, test } from "vitest"

import type { Tone } from "../../src/domain/Appearance.ts"
import type { Review } from "../../src/domain/Review.ts"
import { reviewOfStatus, reviewParts } from "../../src/domain/ReviewAppearance.ts"
import {
  failed,
  PullRequestState,
  succeeded,
  type Ci,
  type Status,
} from "../../src/domain/Snapshot.ts"
import { listLine } from "../../src/server/Tools.ts"
import { acmeRef } from "../support/github.ts"
import { reviewWith } from "../support/reviews.ts"

const open = (ci: Ci, review: Review, draft = false): PullRequestState =>
  PullRequestState.cases.Open.make({
    behind: false,
    ci,
    draft,
    mergeability: "mergeable",
    review,
  })

const fresh = (number: number, state: PullRequestState): Status =>
  succeeded({ ref: acmeRef(number), state, title: "Title" })

const partsOf = (status: Status): readonly (readonly [string, Tone])[] =>
  Option.match(reviewOfStatus(status), {
    onNone: () => [],
    onSome: (review) => reviewParts(review).map((part) => [part.text, part.tone] as const),
  })

type Example = readonly [
  name: string,
  shown: readonly [number: number, status: Status],
  expected: readonly [parts: readonly (readonly [string, Tone])[], line: string],
]

/** The review state design examples: what the sidebar and `pr.list` show. */
const examples: readonly Example[] = [
  [
    "approved of the head commit",
    [12, fresh(12, open("passed", reviewWith("approved")))],
    [[["approved", "green"]], "- https://github.com/acme/api/pull/12 (passed; approved)"],
  ],
  [
    "approved before the latest push",
    [12, fresh(12, open("passed", reviewWith("staleApproval")))],
    [
      [["stale approval", "yellow"]],
      "- https://github.com/acme/api/pull/12 (passed; stale approval)",
    ],
  ],
  [
    "changes requested, with mixed threads",
    [13, fresh(13, open("pending", reviewWith("changesRequested", [2, 1])))],
    [
      [
        ["changes", "yellow"],
        ["2 unreplied", "yellow"],
        ["1 replied", "gray"],
      ],
      "- https://github.com/acme/api/pull/13 (pending; changes requested; 2 unreplied, 1 replied review threads)",
    ],
  ],
  [
    "unknown checks and decision, with a thread of unknown reply",
    [
      15,
      fresh(
        15,
        open("unknown", {
          decision: "unknown",
          threads: { complete: true, fetched: 1, replied: 0, unknown: 1, unreplied: 0 },
        }),
      ),
    ],
    [
      [
        ["review unknown", "gray"],
        ["1 unknown", "gray"],
      ],
      "- https://github.com/acme/api/pull/15 (checks unknown; review decision unknown; 1 unknown review thread)",
    ],
  ],
  [
    "review required, with one thread awaiting the author",
    [14, fresh(14, open("passed", reviewWith("reviewRequired", [1, 0])))],
    [
      [
        ["review", "gray"],
        ["1 unreplied", "yellow"],
      ],
      "- https://github.com/acme/api/pull/14 (passed; review required; 1 unreplied review thread)",
    ],
  ],
  [
    "no decision, with one replied thread",
    [42, fresh(42, open("passed", reviewWith("none", [0, 1])))],
    [
      [["1 replied", "gray"]],
      "- https://github.com/acme/api/pull/42 (passed; 1 replied review thread)",
    ],
  ],
  [
    "failing CI with an approval",
    [40, fresh(40, open("failed", reviewWith("approved", [3, 0])))],
    [
      [
        ["approved", "green"],
        ["3 unreplied", "yellow"],
      ],
      "- https://github.com/acme/api/pull/40 (failed; approved; 3 unreplied review threads)",
    ],
  ],
  [
    "a draft",
    [41, fresh(41, open("passed", reviewWith("none", [2, 0]), true))],
    [
      [["2 unreplied", "yellow"]],
      "- https://github.com/acme/api/pull/41 (draft; 2 unreplied review threads)",
    ],
  ],
  [
    "more than 20 threads",
    [17, fresh(17, open("pending", reviewWith("changesRequested", [12, 3], false)))],
    [
      [
        ["changes", "yellow"],
        ["12+ unreplied", "yellow"],
        ["3+ replied", "gray"],
      ],
      "- https://github.com/acme/api/pull/17 (pending; changes requested; 12+ unreplied, 3+ replied review threads)",
    ],
  ],
  [
    "more than 20 threads, none of the first 20 unresolved",
    [18, fresh(18, open("passed", reviewWith("none", [0, 0], false)))],
    [
      [["20+ threads", "gray"]],
      "- https://github.com/acme/api/pull/18 (passed; 20+ review threads)",
    ],
  ],
  [
    "a failing refresh",
    [
      13,
      failed(
        fresh(13, open("pending", reviewWith("changesRequested", [2, 0]))),
        "GitHubUnavailable",
        0,
      ),
    ],
    [
      [
        ["changes", "yellow"],
        ["2 unreplied", "yellow"],
      ],
      "- https://github.com/acme/api/pull/13 (pending; changes requested; 2 unreplied review threads)",
    ],
  ],
  [
    "merged",
    [10, fresh(10, PullRequestState.cases.Merged.make({}))],
    [[], "- https://github.com/acme/api/pull/10 (merged)"],
  ],
]

describe("review state examples", () => {
  test.each(examples)("%s", (_name, [number, status], [parts, line]) => {
    expect(partsOf(status)).toEqual(parts)
    expect(listLine(acmeRef(number).url, status)).toBe(line)
  })
})
