import { Duration, Option } from "effect"

import type { Status } from "./Snapshot.ts"

export const refreshInterval = Duration.seconds(15)

/**
 * When to refresh a pull request next. Merged pull requests never change, so they stop once a
 * refresh succeeds. A failed refresh was still wanted, such as to learn a merged pull request's
 * current Stack, so it is retried.
 */
export function nextRefresh(status: Status): Option.Option<Duration.Duration> {
  const merged = status._tag === "Fresh" && status.snapshot.state._tag === "Merged"

  return merged ? Option.none() : Option.some(refreshInterval)
}
