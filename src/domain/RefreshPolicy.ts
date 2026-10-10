import { Duration, Option } from "effect"

import { PullRequestState, Status } from "./Snapshot.ts"

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
  const backoff =
    failures > 0
      ? Duration.min(Duration.times(settling, 2 ** (failures - 1)), longestBackoff)
      : settling

  return Status.match(status, {
    Fresh: ({ snapshot }) =>
      PullRequestState.match(snapshot.state, {
        Closed: () => Option.some(closed),
        Merged: () => Option.none(),
        Open: ({ ci, mergeability }) =>
          Option.some(
            ci === "pending" || ci === "unknown" || mergeability === "unknown" ? settling : settled,
          ),
      }),
    Pending: () => Option.some(backoff),
    Stale: () => Option.some(backoff),
    Unavailable: () => Option.some(backoff),
  })
}
