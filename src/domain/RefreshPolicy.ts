import { Duration, Option } from "effect"

import type { Status } from "./Snapshot.ts"

const settling = Duration.seconds(15)

const settled = Duration.seconds(60)

const closed = Duration.minutes(5)

const longestBackoff = Duration.minutes(15)

/**
 * When to refresh a pull request next. An open pull request refreshes quickly while CI runs or
 * GitHub computes mergeability. Unknown CI refreshes quickly too: a check in a status this version
 * does not recognize may still be running, and CI does not record why a check is unknown. A closed one still refreshes so a reopen is noticed. Merged pull
 * requests never change, so they stop once a refresh succeeds. A failed refresh was still wanted,
 * such as to learn a merged pull request's current Stack, so it is retried quickly. After
 * `failures` consecutive failures that cost GitHub work, such as timed-out queries, the retry waits
 * 15 seconds doubled for each failure after the first, up to 15 minutes.
 */
export function nextRefresh(status: Status, failures: number): Option.Option<Duration.Duration> {
  if (status._tag !== "Fresh")
    return Option.some(
      failures > 0
        ? Duration.min(Duration.times(settling, 2 ** (failures - 1)), longestBackoff)
        : settling,
    )

  const { state } = status.snapshot

  if (state._tag === "Merged") return Option.none()

  if (state._tag === "Closed") return Option.some(closed)

  return Option.some(
    state.ci === "pending" || state.ci === "unknown" || state.mergeability === "unknown"
      ? settling
      : settled,
  )
}
