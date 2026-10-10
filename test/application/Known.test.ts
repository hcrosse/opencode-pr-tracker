import { describe, expect, test } from "bun:test"

import { Option } from "effect"

import { afterRefresh, unknown, type Known } from "../../src/application/Known.ts"
import { ItemResult } from "../../src/ports/GitHub.ts"
import { openState, reported, standalone } from "../support/application.ts"
import { ref } from "../support/monitor.ts"

const timedOut: ItemResult = ItemResult.Failed({
  charged: true,
  diagnostic: "GitHubUnavailable",
})

const limited: ItemResult = ItemResult.Failed({ charged: false, diagnostic: "RateLimited" })

const open = reported(ref(1), openState, standalone)

/** Seconds until each next refresh, applying `results` in turn from a pull request not yet known. */
function delays(results: readonly ItemResult[]): number[] {
  let known: Known = unknown
  let now = 0

  return results.map((result: ItemResult) => {
    known = afterRefresh(known, result, now)

    const delay = Option.getOrElse(known.dueAt, () => Number.NaN) - now

    now += delay

    return delay / 1000
  })
}

describe("Known backoff", () => {
  test("doubles the retry after each charged failure, up to 15 minutes", () => {
    expect(delays(Array.from({ length: 9 }, () => timedOut))).toEqual([
      15, 30, 60, 120, 240, 480, 900, 900, 900,
    ])
  })

  test("retries in 15 seconds after an uncharged failure, keeping the count", () => {
    expect(delays([limited, timedOut, timedOut, limited, timedOut])).toEqual([15, 15, 30, 15, 60])
  })

  test("starts over after GitHub reports the pull request", () => {
    expect(delays([timedOut, timedOut, open, timedOut])).toEqual([15, 30, 60, 15])
  })
})
