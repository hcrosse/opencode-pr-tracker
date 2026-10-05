import { Duration, Option } from "effect"

import type { Status } from "./Snapshot.ts"

const settling = Duration.seconds(15)

const settled = Duration.seconds(60)

const closed = Duration.minutes(5)

/**
 * When to refresh a pull request next. An open pull request refreshes quickly while CI runs or
 * GitHub computes mergeability. A closed one still refreshes so a reopen is noticed. Merged pull
 * requests never change, so they stop once a refresh succeeds. A failed refresh was still wanted,
 * such as to learn a merged pull request's current Stack, so it is retried quickly.
 */
export function nextRefresh(status: Status): Option.Option<Duration.Duration> {
  if (status._tag !== "Fresh") return Option.some(settling)

  const { state } = status.snapshot

  if (state._tag === "Merged") return Option.none()

  if (state._tag === "Closed") return Option.some(closed)

  return Option.some(
    state.ci === "pending" || state.mergeability === "unknown" ? settling : settled,
  )
}
