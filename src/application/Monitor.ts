import { Context, Effect, Layer, Option, PubSub, Stream } from "effect"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import type { Status } from "../domain/Snapshot.ts"
import { agreedStacks, type Membership } from "../domain/StackLayout.ts"
import { group, type Attachment, type Tracking } from "../domain/Tracking.ts"
import { ItemResult, type Report } from "../ports/GitHub.ts"
import type { StoredStateInvalid } from "../ports/TrackingRepository.ts"
import { continueAfter, logBySeverity } from "./Causes.ts"
import { InvalidSessions, orWarned } from "./InvalidState.ts"
import { dueOf, isDue, unknown, type Known } from "./Known.ts"
import { Leases } from "./Leases.ts"
import { githubStatuses, type Statuses } from "./Statuses.ts"
import { currentMillis } from "./Time.ts"
import { Tracker } from "./Tracker.ts"

export interface Entry {
  readonly ref: PullRequestRef
  readonly attachedAt: number
  readonly status: Status
  readonly membership: Option.Option<Membership>
}

export interface SessionView {
  readonly sessionID: string
  readonly entries: readonly Entry[]
}

export interface MonitorApi {
  /** The session's pull requests with their latest known status. Renews the session's lease. */
  readonly view: (sessionID: string) => Effect.Effect<SessionView, StoredStateInvalid>
  /**
   * Refreshes the session's pull requests now, except merged ones, and returns the result. Renews
   * the session's lease.
   */
  readonly refresh: (sessionID: string) => Effect.Effect<SessionView, StoredStateInvalid>
  /**
   * Shows a session after `ref` was attached: records what GitHub reported for `ref` so it is not
   * fetched again, then continues as `show`.
   */
  readonly attached: (
    sessionID: string,
    ref: PullRequestRef,
    report: Report,
  ) => Effect.Effect<SessionView, StoredStateInvalid>
  /**
   * Fetches the session's pull requests whose status is not yet known, publishes its view, and
   * returns it. Use after its attachments change.
   */
  readonly show: (sessionID: string) => Effect.Effect<SessionView, StoredStateInvalid>
  /** Fetches due or unknown statuses for a one-time answer, and renews the session's lease. */
  readonly current: (sessionID: string) => Effect.Effect<SessionView, StoredStateInvalid>
  /** Renews the session's lease: `poll` refreshes it until the lease lapses. */
  readonly watch: (sessionID: string) => Effect.Effect<void>
  /** Stops watching a session. Safe to repeat. */
  readonly forget: (sessionID: string) => Effect.Effect<void>
  /** Refreshes every due pull request of the sessions whose lease is live. Run it repeatedly. */
  readonly poll: Effect.Effect<void>
  /** A session's view after each refresh of it, including refreshes that `poll` runs. */
  readonly changes: Stream.Stream<SessionView>
}

export class Monitor extends Context.Service<Monitor, MonitorApi>()(
  "opencode-pr-tracker/Monitor",
) {}

function entryOf(known: ReadonlyMap<string, Known>, attachment: Attachment): Entry {
  const current = known.get(attachment.ref.url) ?? unknown

  return {
    attachedAt: attachment.attachedAt,
    membership: current.membership,
    ref: attachment.ref,
    status: current.status,
  }
}

/** The attached pull requests of every session, by URL. */
const attachedIn = (trackings: ReadonlyMap<string, Tracking>): Map<string, PullRequestRef> =>
  new Map([...trackings.values()].flat().map((attachment) => [attachment.ref.url, attachment.ref]))

/** The sessions with any of `refs` attached. */
const sessionsWith = (
  trackings: ReadonlyMap<string, Tracking>,
  refs: readonly PullRequestRef[],
): string[] => {
  const urls = new Set(refs.map((ref) => ref.url))

  return [...trackings].flatMap(([sessionID, tracking]: readonly [string, Tracking]) =>
    tracking.some((attachment) => urls.has(attachment.ref.url)) ? [sessionID] : [],
  )
}

interface Views {
  /** The session's view. Agreed Stacks whose attached members sit apart are regrouped first. */
  readonly viewOf: (sessionID: string) => Effect.Effect<SessionView, StoredStateInvalid>
  /** Publishes the session's view and returns it. */
  readonly show: (sessionID: string) => Effect.Effect<SessionView, StoredStateInvalid>
  /** Publishes the session's view, logging rather than failing when it cannot be read. */
  readonly publish: (sessionID: string) => Effect.Effect<void>
  readonly changes: Stream.Stream<SessionView>
}

const sessionViews = Effect.fnUntraced(function* (
  snapshot: Effect.Effect<ReadonlyMap<string, Known>>,
) {
  const tracker = yield* Tracker
  const published = yield* PubSub.unbounded<SessionView>()

  const viewOf = Effect.fn("Monitor.viewOf")(function* (
    sessionID: string,
  ): Effect.fn.Return<SessionView, StoredStateInvalid> {
    const stored = yield* tracker.list(sessionID)
    const current = yield* snapshot
    const entries = stored.map((attachment) => entryOf(current, attachment))
    const stacks = agreedStacks(entries).map((stack) => stack.members)

    if (!group(stored, stacks).changed) return { entries, sessionID }
    // A failed regroup leaves the stored order as it was.
    const regrouped = tracker.regroup(sessionID, stacks)
    const tracking = yield* orWarned(regrouped, "Kept the order after a failed regroup", stored)

    return { entries: tracking.map((attachment) => entryOf(current, attachment)), sessionID }
  })

  const show = (sessionID: string): Effect.Effect<SessionView, StoredStateInvalid> =>
    Effect.tap(viewOf(sessionID), (view: SessionView) => PubSub.publish(published, view))

  const views: Views = {
    changes: Stream.fromPubSub(published),
    publish: (sessionID) =>
      show(sessionID).pipe(
        continueAfter(logBySeverity("Session view was not published after a refresh")),
        Effect.annotateLogs({ sessionID }),
      ),
    show,
    viewOf,
  }

  return views
})

interface Watching {
  /** Renews the session's lease. */
  readonly watch: (sessionID: string) => Effect.Effect<void>
  readonly forget: (sessionID: string) => Effect.Effect<void>
  /** Refreshes every due pull request of the sessions whose lease is live. */
  readonly poll: Effect.Effect<void>
}

const watching = Effect.fnUntraced(function* (statuses: Statuses, views: Views) {
  const tracker = yield* Tracker
  const leases = new Leases()
  const invalid = new InvalidSessions((sessionID) => tracker.list(sessionID))

  const poll = Effect.fn("Monitor.poll")(function* (): Effect.fn.Return<void> {
    const sessions = yield* leases.live()
    // Taken before listing attachments: statuses recorded after this belong to newer attachments.
    const before = yield* statuses.snapshot
    const trackings = yield* invalid.validTrackings(sessions)
    const attached = attachedIn(trackings)
    const now = yield* currentMillis
    // Choose from the cache as it is now: an attach may have recorded a report while listing.
    const due = dueOf(yield* statuses.snapshot, now, [...attached.values()])

    // A session renewed while listing has statuses a reader may need, so pruning waits a poll.
    if ((yield* leases.live()).every((id) => sessions.includes(id)))
      yield* statuses.prune(before, attached)

    if (due.length === 0) return

    yield* statuses.fetch(due)

    yield* Effect.forEach(sessionsWith(trackings, due), (id: string) => views.publish(id), {
      discard: true,
    })
  })

  const watched: Watching = {
    forget: (id) => Effect.andThen(leases.end(id), invalid.end(id)),
    poll: poll(),
    watch: (id) => leases.renew(id),
  }

  return watched
})

type Selection = (known: ReadonlyMap<string, Known>, now: number, ref: PullRequestRef) => boolean

const refreshable: Selection = (known, _now, ref) =>
  Option.isSome((known.get(ref.url) ?? unknown).dueAt)

const notYetKnown: Selection = (known, _now, ref) => !known.has(ref.url)

export const layer = Layer.effect(
  Monitor,
  Effect.gen(function* () {
    const tracker = yield* Tracker
    const statuses = yield* githubStatuses
    const views = yield* sessionViews(statuses.snapshot)
    const { forget, poll, watch } = yield* watching(statuses, views)

    /** Fetches the session's pull requests that `select` picks, then publishes and returns its view. */
    const fetchAndShow = Effect.fn("Monitor.fetchAndShow")(function* (
      sessionID: string,
      select: Selection,
    ): Effect.fn.Return<SessionView, StoredStateInvalid> {
      const tracking = yield* tracker.list(sessionID)
      const known = yield* statuses.snapshot
      const now = yield* currentMillis

      yield* statuses.fetch(
        tracking.map((attachment) => attachment.ref).filter((ref) => select(known, now, ref)),
      )

      return yield* views.show(sessionID)
    })

    return Monitor.of({
      attached: (sessionID, ref, report) =>
        Effect.andThen(
          statuses.remember(new Map([[ref.url, ItemResult.Reported({ report })]])),
          fetchAndShow(sessionID, notYetKnown),
        ),
      changes: views.changes,
      current: (sessionID) => Effect.andThen(watch(sessionID), fetchAndShow(sessionID, isDue)),
      forget,
      poll,
      refresh: (sessionID) =>
        Effect.andThen(watch(sessionID), fetchAndShow(sessionID, refreshable)),
      show: (sessionID) => fetchAndShow(sessionID, notYetKnown),
      view: (sessionID) => Effect.andThen(watch(sessionID), views.viewOf(sessionID)),
      watch,
    })
  }),
)
