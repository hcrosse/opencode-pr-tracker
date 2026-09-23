/** What the monitor knows about one pull request, and when to ask GitHub again. */
import { Duration, Option } from "effect"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import { nextRefresh } from "../domain/RefreshPolicy.ts"
import { failed, pending, succeeded, type Status } from "../domain/Snapshot.ts"
import type { Membership } from "../domain/StackLayout.ts"
import type { ItemResult } from "../ports/GitHub.ts"

export interface Known {
  readonly status: Status
  readonly membership: Option.Option<Membership>
  /** When to refresh next; none once refreshing can no longer change anything. */
  readonly dueAt: Option.Option<number>
}

export const unknown: Known = { dueAt: Option.some(0), membership: Option.none(), status: pending }

export function afterRefresh(previous: Known, result: ItemResult, now: number): Known {
  const status =
    result._tag === "Reported"
      ? succeeded(result.report.snapshot)
      : failed(previous.status, result.diagnostic, now)

  const membership = result._tag === "Reported" ? result.report.membership : previous.membership

  return {
    dueAt: Option.map(nextRefresh(status), (delay) => now + Duration.toMillis(delay)),
    membership,
    status,
  }
}

export const isDue =
  (known: ReadonlyMap<string, Known>, now: number) =>
  (ref: PullRequestRef): boolean =>
    Option.match((known.get(ref.url) ?? unknown).dueAt, {
      onNone: () => false,
      onSome: (at: number) => at <= now,
    })

/**
 * `entries` without pull requests that no session in use has attached, as of the `before`
 * snapshot. Entries that changed since were recorded for attachments newer than the snapshot.
 */
export function withoutUnattached(
  entries: ReadonlyMap<string, Known>,
  before: ReadonlyMap<string, Known>,
  attached: ReadonlyMap<string, PullRequestRef>,
): ReadonlyMap<string, Known> {
  return new Map(
    [...entries].filter(
      ([url, entry]: readonly [string, Known]) => attached.has(url) || entry !== before.get(url),
    ),
  )
}
