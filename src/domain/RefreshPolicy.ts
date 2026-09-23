import { Duration, Option } from "effect"

import type { Status } from "./Snapshot.ts"

export const refreshInterval = Duration.seconds(15)

/** When to refresh a pull request next. Merged pull requests never change, so they stop. */
export function nextRefresh(status: Status): Option.Option<Duration.Duration> {
  const merged =
    (status._tag === "Fresh" || status._tag === "Stale") && status.snapshot.state._tag === "Merged"

  return merged ? Option.none() : Option.some(refreshInterval)
}
