import { Context, Effect, Layer, Option, PubSub, Ref, Stream } from "effect"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import type { Status } from "../domain/Snapshot.ts"
import { agreedStacks, type Membership } from "../domain/StackLayout.ts"
import { group, type Attachment, type Tracking } from "../domain/Tracking.ts"
import { GitHub, ItemResult, type GitHubApi, type Report } from "../ports/GitHub.ts"
import type { StoredStateInvalid } from "../ports/TrackingRepository.ts"
import { continueAfter, logBySeverity } from "./Causes.ts"
import { FetchQueue } from "./FetchQueue.ts"
import { InvalidSessions, orWarned } from "./InvalidState.ts"
import {
  dueOf,
  failedEach,
  isDue,
  recorded,
  unknown,
  withoutUnattached,
  type Known,
} from "./Known.ts"
import { Leases } from "./Leases.ts"
import { currentMillis } from "./Time.ts"
import { Tracker, type TrackerApi } from "./Tracker.ts"

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

const urlsOf = (tracking: Tracking): string[] => tracking.map((attachment) => attachment.ref.url)

interface Cache {
  readonly github: GitHubApi
  readonly known: Ref.Ref<ReadonlyMap<string, Known>>
}

interface State extends Cache {
  readonly tracker: TrackerApi
  readonly leases: Leases
  readonly invalid: InvalidSessions
  readonly published: PubSub.PubSub<SessionView>
  /** Fetches pull requests and records the results; see `FetchQueue`. */
  readonly fetch: (refs: readonly PullRequestRef[]) => Effect.Effect<void>
}

/** Records GitHub's results for pull requests as of now. */
const remember = Effect.fn("Monitor.remember")(function* (
  cache: Cache,
  results: ReadonlyMap<string, ItemResult>,
): Effect.fn.Return<void> {
  const now = yield* currentMillis

  yield* Ref.update(cache.known, (current: ReadonlyMap<string, Known>) =>
    recorded(current, results, now),
  )
})

/** Fetches `refs` and records what GitHub said; a failed request counts against each of them. */
function update(cache: Cache, refs: readonly PullRequestRef[]): Effect.Effect<void> {
  return cache.github.fetch(refs).pipe(
    Effect.catchTag("GitHubFailure", (failure) => Effect.succeed(failedEach(refs, failure))),
    Effect.flatMap((results: ReadonlyMap<string, ItemResult>) => remember(cache, results)),
  )
}

/** The session's view. Agreed Stacks whose attached members sit apart are regrouped first. */
const viewOf = Effect.fn("Monitor.viewOf")(function* (
  state: State,
  sessionID: string,
): Effect.fn.Return<SessionView, StoredStateInvalid> {
  const stored = yield* state.tracker.list(sessionID)
  const current = yield* Ref.get(state.known)
  const entries = stored.map((attachment) => entryOf(current, attachment))
  const stacks = agreedStacks(entries).map((stack) => stack.members)

  if (!group(stored, stacks).changed) return { entries, sessionID }
  // A failed regroup leaves the stored order as it was.
  const regrouped = state.tracker.regroup(sessionID, stacks)
  const tracking = yield* orWarned(regrouped, "Kept the order after a failed regroup", stored)

  return { entries: tracking.map((attachment) => entryOf(current, attachment)), sessionID }
})

const publish = (state: State, sessionID: string): Effect.Effect<void> =>
  viewOf(state, sessionID).pipe(
    Effect.flatMap((view: SessionView) => PubSub.publish(state.published, view)),
    continueAfter(logBySeverity("Session view was not published after a refresh")),
    Effect.annotateLogs({ sessionID }),
  )

const poll = Effect.fn("Monitor.poll")(function* (state: State): Effect.fn.Return<void> {
  const sessions = yield* state.leases.live()
  // Taken before listing attachments: statuses recorded after this belong to newer attachments.
  const known = yield* Ref.get(state.known)
  const trackings = yield* state.invalid.validTrackings(state.tracker, sessions)

  const attached = new Map(
    [...trackings.values()].flat().map((attachment) => [attachment.ref.url, attachment.ref]),
  )

  const now = yield* currentMillis
  // Choose from the cache as it is now: an attach may have recorded a report while listing.
  const current = yield* Ref.get(state.known)
  const due = dueOf(current, now, [...attached.values()])

  // A session renewed while listing has statuses a reader may need, so pruning waits a poll.
  if ((yield* state.leases.live()).every((id) => sessions.includes(id)))
    yield* Ref.update(state.known, (entries: ReadonlyMap<string, Known>) =>
      withoutUnattached(entries, known, attached),
    )

  if (due.length === 0) return

  yield* state.fetch(due)

  const dueUrls = new Set(due.map((ref) => ref.url))

  const affected = [...trackings].flatMap(([sessionID, tracking]: readonly [string, Tracking]) =>
    urlsOf(tracking).some((url) => dueUrls.has(url)) ? [sessionID] : [],
  )

  yield* Effect.forEach(affected, (sessionID: string) => publish(state, sessionID), {
    discard: true,
  })
})

type Selection = (known: ReadonlyMap<string, Known>, now: number, ref: PullRequestRef) => boolean

/** Fetches the session's pull requests that `select` picks, then publishes and returns its view. */
const fetchAndShow = Effect.fn("Monitor.fetchAndShow")(function* (
  state: State,
  sessionID: string,
  select: Selection,
): Effect.fn.Return<SessionView, StoredStateInvalid> {
  const tracking = yield* state.tracker.list(sessionID)
  const known = yield* Ref.get(state.known)
  const now = yield* currentMillis

  yield* state.fetch(
    tracking.map((attachment) => attachment.ref).filter((ref) => select(known, now, ref)),
  )
  const view = yield* viewOf(state, sessionID)

  yield* PubSub.publish(state.published, view)

  return view
})

const refreshable: Selection = (known, _now, ref) =>
  Option.isSome((known.get(ref.url) ?? unknown).dueAt)

const notYetKnown: Selection = (known, _now, ref) => !known.has(ref.url)

export const layer = Layer.effect(
  Monitor,
  Effect.gen(function* () {
    const cache: Cache = {
      github: yield* GitHub,
      known: yield* Ref.make<ReadonlyMap<string, Known>>(new Map()),
    }

    const queue = new FetchQueue((refs) => update(cache, refs), yield* Effect.scope)

    const state: State = {
      fetch: (refs) => queue.fetch(refs),
      github: cache.github,
      known: cache.known,
      published: yield* PubSub.unbounded<SessionView>(),
      invalid: new InvalidSessions(),
      leases: new Leases(),
      tracker: yield* Tracker,
    }

    return Monitor.of({
      changes: Stream.fromPubSub(state.published),
      current: (sessionID) =>
        Effect.andThen(state.leases.renew(sessionID), fetchAndShow(state, sessionID, isDue)),
      forget: (id) => Effect.andThen(state.leases.end(id), state.invalid.end(id)),
      poll: poll(state),
      attached: (sessionID, ref, report) =>
        Effect.andThen(
          remember(cache, new Map([[ref.url, ItemResult.Reported({ report })]])),
          fetchAndShow(state, sessionID, notYetKnown),
        ),
      refresh: (sessionID) =>
        Effect.andThen(state.leases.renew(sessionID), fetchAndShow(state, sessionID, refreshable)),
      show: (sessionID) => fetchAndShow(state, sessionID, notYetKnown),
      view: (sessionID) => Effect.andThen(state.leases.renew(sessionID), viewOf(state, sessionID)),
      watch: (sessionID) => state.leases.renew(sessionID),
    })
  }),
)
