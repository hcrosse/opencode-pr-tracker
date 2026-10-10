import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Array as Arr, Option, Schema } from "effect"
import { describe, expect, test } from "vitest"

import { noReview } from "../../src/domain/Review.ts"
import {
  Ci,
  failed,
  Mergeability,
  PullRequestState,
  pending,
  succeeded,
  Status,
  type Diagnostic,
  type Snapshot,
} from "../../src/domain/Snapshot.ts"
import { diagnostics, reviews, snapshots } from "../support/generators.ts"

const fiveMinutes = 5 * 60 * 1000

const latestEpochMillis = 4_102_444_800_000

const openWithoutJson =
  '{"_tag":"Open","behind":false,"ci":"passed","draft":false,"mergeability":"mergeable"}'

const openWithout: unknown = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
  openWithoutJson,
)

const previousPullRequestState = Schema.TaggedStruct("Open", {
  behind: Schema.Boolean,
  ci: Ci,
  draft: Schema.Boolean,
  mergeability: Mergeability,
})

interface Success {
  readonly kind: "success"
  readonly snapshot: Snapshot
  readonly at: number
}

interface Failure {
  readonly kind: "failure"
  readonly diagnostic: Diagnostic
  readonly at: number
}

type Event = Success | Failure

const isSuccess = (event: Event): event is Success => event.kind === "success"

const events = gs.composite((tc): Event[] => {
  let at = tc.draw(gs.integers({ maxValue: latestEpochMillis, minValue: 0 }))

  return tc
    .draw(
      gs.arrays(gs.tuples(gs.booleans(), gs.integers({ maxValue: 2 * fiveMinutes, minValue: 0 }))),
    )
    .map(([success, elapsed]: readonly [boolean, number]): Event => {
      at += elapsed

      return success
        ? { at, kind: "success", snapshot: tc.draw(snapshots) }
        : { at, diagnostic: tc.draw(diagnostics), kind: "failure" }
    })
})

function expectedAfterFailure(log: readonly Event[], last: Failure): Status {
  const unavailable = Status.cases.Unavailable.make({ diagnostic: last.diagnostic })

  const lastSuccess = Option.all({
    index: Arr.findLastIndex(log, isSuccess),
    success: Arr.findLast(log, isSuccess),
  })

  return Option.match(lastSuccess, {
    onNone: () => unavailable,
    onSome: ({ index, success }): Status => {
      const failingSince = Option.match(Arr.get(log, index + 1), {
        onNone: () => last.at,
        onSome: (event) => event.at,
      })

      // Only a failure other than a rate limit, five minutes or more into failing, withdraws it.
      const withdrawn = log
        .slice(index + 1)
        .some(
          (event) =>
            event.kind === "failure" &&
            event.diagnostic !== "RateLimited" &&
            event.at - failingSince >= fiveMinutes,
        )

      return withdrawn
        ? unavailable
        : Status.cases.Stale.make({
            diagnostic: last.diagnostic,
            failingSince,
            snapshot: success.snapshot,
          })
    },
  })
}

/** The status the log implies, judged from the whole history rather than step by step. */
function expectedStatus(log: readonly Event[]): Status {
  return Option.match(Arr.last(log), {
    onNone: () => pending,
    onSome: (last) =>
      isSuccess(last)
        ? Status.cases.Fresh.make({ snapshot: last.snapshot })
        : expectedAfterFailure(log, last),
  })
}

function replay(log: readonly Event[]): Status {
  let status = pending

  for (const event of log) {
    status =
      event.kind === "success"
        ? succeeded(event.snapshot)
        : failed(status, event.diagnostic, event.at)
  }

  return status
}

describe("refresh status", () => {
  test("every history of successes and failures ends in the status it implies", () => {
    hegel.test((tc) => {
      const log = tc.draw(events)

      for (let length = 0; length <= log.length; length += 1) {
        expect(replay(log.slice(0, length))).toEqual(expectedStatus(log.slice(0, length)))
      }
    })
  })

  test("keeps the last snapshot, marked stale, until five minutes of failures", () => {
    hegel.test((tc) => {
      const snapshot = tc.draw(snapshots)
      const stale = failed(succeeded(snapshot), "GitHubUnavailable", 0)

      expect(failed(stale, "GitHubUnavailable", fiveMinutes - 1)).toEqual(
        Status.cases.Stale.make({
          diagnostic: "GitHubUnavailable",
          failingSince: 0,
          snapshot,
        }),
      )
      expect(failed(stale, "GitHubUnavailable", fiveMinutes)).toEqual(
        Status.cases.Unavailable.make({ diagnostic: "GitHubUnavailable" }),
      )
    })
  })
})

describe("refresh status while rate limited", () => {
  test("keeps the last snapshot, marked stale, however long GitHub rate limits", () => {
    hegel.test((tc) => {
      const snapshot = tc.draw(snapshots)
      const later = tc.draw(gs.integers({ maxValue: latestEpochMillis, minValue: fiveMinutes }))
      const stale = failed(succeeded(snapshot), "RateLimited", 0)

      expect(failed(stale, "RateLimited", later)).toEqual(
        Status.cases.Stale.make({
          diagnostic: "RateLimited",
          failingSince: 0,
          snapshot,
        }),
      )
    })
  })
})

describe("snapshot compatibility across versions", () => {
  test("reads an open state from a server without review state as having none", () => {
    expect(Schema.decodeUnknownSync(PullRequestState)(openWithout)).toEqual(
      PullRequestState.cases.Open.make({
        behind: false,
        ci: "passed",
        draft: false,
        mergeability: "mergeable",
        review: noReview,
      }),
    )
  })

  test("sends review state that a client without it ignores", () => {
    hegel.test((tc) => {
      const review = tc.draw(reviews)

      const encoded = Schema.encodeSync(PullRequestState)(
        PullRequestState.cases.Open.make({
          behind: false,
          ci: "passed",
          draft: false,
          mergeability: "mergeable",
          review,
        }),
      )

      expect(Schema.decodeUnknownSync(previousPullRequestState)(encoded)).toEqual(
        previousPullRequestState.make({
          behind: false,
          ci: "passed",
          draft: false,
          mergeability: "mergeable",
        }),
      )
    })
  })
})

describe("tagged schema encoding", () => {
  test("keeps the existing tags in status and pull request state JSON", () => {
    expect(
      JSON.stringify(Schema.encodeSync(PullRequestState)(PullRequestState.cases.Merged.make({}))),
    ).toBe('{"_tag":"Merged"}')
    expect(JSON.stringify(Schema.encodeSync(Status)(Status.cases.Pending.make({})))).toBe(
      '{"_tag":"Pending"}',
    )
  })
})
