import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Array as Arr, Option } from "effect"

import {
  failed,
  pending,
  succeeded,
  type Diagnostic,
  type Snapshot,
  type Status,
} from "../../src/domain/Snapshot.ts"
import { diagnostics, snapshots } from "../support/generators.ts"

const fiveMinutes = 5 * 60 * 1000

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
  let at = tc.draw(gs.integers({ minValue: 0 }))

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
  const unavailable: Status = { _tag: "Unavailable", diagnostic: last.diagnostic }

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

      return last.at - failingSince >= fiveMinutes
        ? unavailable
        : { _tag: "Stale", diagnostic: last.diagnostic, failingSince, snapshot: success.snapshot }
    },
  })
}

/** The status the log implies, judged from the whole history rather than step by step. */
function expectedStatus(log: readonly Event[]): Status {
  return Option.match(Arr.last(log), {
    onNone: () => pending,
    onSome: (last) =>
      isSuccess(last)
        ? { _tag: "Fresh", snapshot: last.snapshot }
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

      expect(failed(stale, "GitHubUnavailable", fiveMinutes - 1)).toEqual({
        _tag: "Stale",
        diagnostic: "GitHubUnavailable",
        failingSince: 0,
        snapshot,
      })
      expect(failed(stale, "GitHubUnavailable", fiveMinutes)).toEqual({
        _tag: "Unavailable",
        diagnostic: "GitHubUnavailable",
      })
    })
  })
})
