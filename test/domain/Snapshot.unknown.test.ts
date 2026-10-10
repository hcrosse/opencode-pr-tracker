import * as hegel from "@hegeldev/hegel"
import { Option, Schema } from "effect"
import { describe, expect, test } from "vitest"

import { noReview } from "../../src/domain/Review.ts"
import { Mergeability, PullRequestState } from "../../src/domain/Snapshot.ts"
import { pullRequestStates } from "../support/generators.ts"

/** The open state as a client from before unknown states decodes it. */
const previous = Schema.TaggedStruct("Open", {
  behind: Schema.Boolean,
  ci: Schema.Literals(["passed", "pending", "failed", "none"]),
  draft: Schema.Boolean,
  mergeability: Mergeability,
  review: Schema.Struct({
    decision: Schema.Literals([
      "approved",
      "staleApproval",
      "changesRequested",
      "reviewRequired",
      "none",
    ]),
    threads: Schema.Struct({
      complete: Schema.Boolean,
      fetched: Schema.Int,
      replied: Schema.Int,
      unreplied: Schema.Int,
    }),
  }),
})

const unknownOpen: PullRequestState = PullRequestState.cases.Open.make({
  behind: "unknown",
  ci: "unknown",
  draft: false,
  mergeability: "mergeable",
  review: {
    decision: "unknown",
    threads: { complete: true, fetched: 3, replied: 1, unknown: 1, unreplied: 1 },
  },
})

describe("unknown states sent to an earlier client", () => {
  test("an earlier client reads unknown parts as it did before they existed", () => {
    const encoded = Schema.encodeSync(PullRequestState)(unknownOpen)

    expect(JSON.stringify(Schema.decodeUnknownSync(previous)(encoded))).toBe(
      '{"_tag":"Open","behind":false,"ci":"pending","draft":false,"mergeability":"mergeable","review":{"decision":"none","threads":{"complete":true,"fetched":3,"replied":1,"unreplied":1}}}',
    )
  })
})

describe("unknown states read by a current client", () => {
  test("a current client reads every state back as sent", () => {
    hegel.test((tc) => {
      const state = tc.draw(pullRequestStates)
      const encoded = Schema.encodeSync(PullRequestState)(state)

      expect(Schema.decodeUnknownSync(PullRequestState)(encoded)).toEqual(state)
    })
  })

  test("a current client reads an earlier server's open state as having nothing unknown", () => {
    const sent = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
      '{"_tag":"Open","behind":true,"ci":"passed","draft":false,"mergeability":"mergeable","review":{"decision":"none","threads":{"complete":true,"fetched":0,"replied":0,"unreplied":0}}}',
    )

    expect(Schema.decodeUnknownSync(PullRequestState)(sent)).toEqual(
      PullRequestState.cases.Open.make({
        behind: true,
        ci: "passed",
        draft: false,
        mergeability: "mergeable",
        review: noReview,
      }),
    )
  })
})

interface Counts {
  readonly fetched: number
  readonly replied: number
  readonly unknown: number
  readonly unreplied: number
}

describe("impossible thread counts sent to a current client", () => {
  test.each<readonly [string, Counts]>([
    ["more counted threads than fetched", { fetched: 2, replied: 1, unknown: 2, unreplied: 0 }],
    ["a negative unknown count", { fetched: 3, replied: 1, unknown: -1, unreplied: 0 }],
  ])("are rejected, not a defect: %s", (_name, counts) => {
    const sent = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
      `{"_tag":"Open","behind":false,"ci":"passed","draft":false,"mergeability":"mergeable","review":{"decision":"none","threads":{"complete":true,"fetched":${String(counts.fetched)},"replied":${String(counts.replied)},"unknown":${String(counts.unknown)},"unreplied":${String(counts.unreplied)}}}}`,
    )

    expect(Schema.decodeUnknownOption(PullRequestState)(sent)).toEqual(Option.none())
  })
})
