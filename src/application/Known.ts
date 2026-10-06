/** What the monitor knows about one pull request, and when to ask GitHub again. */
import { Duration, Option } from "effect"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import { nextRefresh } from "../domain/RefreshPolicy.ts"
import { failed, pending, succeeded, type Status } from "../domain/Snapshot.ts"
import type { Membership } from "../domain/StackLayout.ts"
import type { GitHubFailure, ItemResult } from "../ports/GitHub.ts"

export interface Known {
  readonly status: Status
  readonly membership: Option.Option<Membership>
  /** When to refresh next; none once refreshing can no longer change anything. */
  readonly dueAt: Option.Option<number>
  /** Consecutive failed refreshes that cost GitHub work; each lengthens the wait for the next. */
  readonly failures: number
}

export const unknown: Known = {
  dueAt: Option.some(0),
  failures: 0,
  membership: Option.none(),
  status: pending,
}

function failuresAfter(previous: Known, result: ItemResult): number {
  if (result._tag === "Reported") return 0

  return result.charged ? previous.failures + 1 : previous.failures
}

export function afterRefresh(previous: Known, result: ItemResult, now: number): Known {
  const status =
    result._tag === "Reported"
      ? succeeded(result.report.snapshot)
      : failed(previous.status, result.diagnostic, now)

  const membership = result._tag === "Reported" ? result.report.membership : previous.membership
  const failures = failuresAfter(previous, result)
  // An uncharged failure retries soon; the count it keeps applies once a charged failure follows.
  const backoff = result._tag === "Failed" && !result.charged ? 0 : failures

  return {
    dueAt: Option.map(nextRefresh(status, backoff), (delay) => now + Duration.toMillis(delay)),
    failures,
    membership,
    status,
  }
}

const membersOf = (membership: Option.Option<Membership>): readonly PullRequestRef[] =>
  Option.match(membership, {
    onNone: () => [],
    onSome: (known) => (known._tag === "Stack" ? known.members : []),
  })

/** Membership as a comparable string: none, standalone, or the Stack with its members in order. */
const keyOf = (membership: Option.Option<Membership>): string =>
  Option.match(membership, {
    onNone: () => "",
    onSome: (known) =>
      known._tag === "Stack"
        ? [known.id, ...known.members.map((member) => member.url)].join("\n")
        : "standalone",
  })

const sameMembership = (
  left: Option.Option<Membership>,
  right: Option.Option<Membership>,
): boolean => keyOf(left) === keyOf(right)

/** Whether `known` stopped refreshing with membership other than `reported`. */
const outdated = (known: Option.Option<Known>, reported: Option.Option<Membership>): boolean =>
  Option.exists(
    known,
    (entry) => Option.isNone(entry.dueAt) && !sameMembership(entry.membership, reported),
  )

/**
 * Pull requests to ask about again because a changed Stack report contradicts what is known about
 * them. Merged pull requests stop refreshing, so without this their membership would stay as it
 * was when they merged, and a Stack linked or unlinked afterwards would never agree. A report that
 * does not change asks for nothing, so a lasting contradiction costs one extra refresh.
 */
function contradicted(
  current: ReadonlyMap<string, Known>,
  results: ReadonlyMap<string, ItemResult>,
): Set<string> {
  const urls = new Set<string>()

  for (const [url, result] of results) {
    if (result._tag !== "Reported") continue

    const reported = result.report.membership
    const previous = (current.get(url) ?? unknown).membership

    if (sameMembership(previous, reported)) continue

    for (const member of [...membersOf(previous), ...membersOf(reported)]) {
      const known = Option.fromNullishOr(current.get(member.url))

      if (!results.has(member.url) && outdated(known, reported)) urls.add(member.url)
    }
  }

  return urls
}

/** Results for a fetch that failed as a whole, which it does only when that cost GitHub nothing. */
export const failedEach = (
  refs: readonly PullRequestRef[],
  { diagnostic }: GitHubFailure,
): ReadonlyMap<string, ItemResult> =>
  new Map(refs.map((ref) => [ref.url, { _tag: "Failed", charged: false, diagnostic }] as const))

/** `current` with GitHub's `results` recorded as of `now`. */
export function recorded(
  current: ReadonlyMap<string, Known>,
  results: ReadonlyMap<string, ItemResult>,
  now: number,
): Map<string, Known> {
  const next = new Map(current)

  for (const [url, result] of results)
    next.set(url, afterRefresh(current.get(url) ?? unknown, result, now))

  // Contradicted pull requests are known and were not in `results`, so they are as in `current`.
  for (const url of contradicted(current, results)) {
    const { failures, membership, status } = current.get(url) ?? unknown

    next.set(url, { dueAt: Option.some(now), failures, membership, status })
  }

  return next
}

export const isDue = (
  known: ReadonlyMap<string, Known>,
  now: number,
  ref: PullRequestRef,
): boolean =>
  Option.match((known.get(ref.url) ?? unknown).dueAt, {
    onNone: () => false,
    onSome: (at: number) => at <= now,
  })

/**
 * The due pull requests of `refs`, those with the most consecutive charged failures first, so
 * pull requests left unsent when a refresh stopped early go first the next time.
 */
export function dueOf(
  known: ReadonlyMap<string, Known>,
  now: number,
  refs: readonly PullRequestRef[],
): PullRequestRef[] {
  const failuresOf = (ref: PullRequestRef): number => (known.get(ref.url) ?? unknown).failures

  return refs
    .filter((ref) => isDue(known, now, ref))
    .toSorted((left, right) => failuresOf(right) - failuresOf(left))
}

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
