import { Context, Effect, Layer, Option, PubSub, Ref, Result, Stream } from "effect"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import type { Status } from "../domain/Snapshot.ts"
import { agreedStacks, type Membership } from "../domain/StackLayout.ts"
import { group, type Attachment, type Tracking } from "../domain/Tracking.ts"
import { GitHub, type GitHubApi, type ItemResult, type Report } from "../ports/GitHub.ts"
import type { StoredStateInvalid } from "../ports/TrackingRepository.ts"
import { FetchQueue } from "./FetchQueue.ts"
import { isDue, recorded, unknown, withoutUnattached, type Known } from "./Known.ts"
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
  /** The session's pull requests with their latest known status. Marks the session as in use. */
  readonly view: (sessionID: string) => Effect.Effect<SessionView, StoredStateInvalid>
  /** Refreshes the session's pull requests now, except merged ones, and returns the result. */
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
   * returns it. Marks the session as in use. Use after its attachments change.
   */
  readonly show: (sessionID: string) => Effect.Effect<SessionView, StoredStateInvalid>
  /** Stops watching a session. Safe to repeat. */
  readonly forget: (sessionID: string) => Effect.Effect<void>
  /** Refreshes every due pull request of the sessions in use. Run it repeatedly. */
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
  readonly working: Ref.Ref<ReadonlySet<string>>
  readonly published: PubSub.PubSub<SessionView>
  /** Fetches pull requests and records the results; see `FetchQueue`. */
  readonly fetch: (refs: readonly PullRequestRef[]) => Effect.Effect<void>
}

/** Records GitHub's results for pull requests as of now. */
function remember(cache: Cache, results: ReadonlyMap<string, ItemResult>): Effect.Effect<void> {
  return Effect.gen(function* () {
    const now = yield* currentMillis

    yield* Ref.update(cache.known, (current: ReadonlyMap<string, Known>) =>
      recorded(current, results, now),
    )
  })
}

/** Fetches `refs` and records what GitHub said; a failed request counts against each of them. */
function update(cache: Cache, refs: readonly PullRequestRef[]): Effect.Effect<void> {
  return Effect.gen(function* () {
    const outcome = yield* Effect.result(cache.github.fetch(refs))

    const results: ReadonlyMap<string, ItemResult> = Result.isSuccess(outcome)
      ? outcome.success
      : new Map(
          refs.map(
            (ref) => [ref.url, { _tag: "Failed", diagnostic: outcome.failure.diagnostic }] as const,
          ),
        )

    yield* remember(cache, results)
  })
}

/** The session's view. Agreed Stacks whose attached members sit apart are regrouped first. */
function viewOf(state: State, sessionID: string): Effect.Effect<SessionView, StoredStateInvalid> {
  return Effect.gen(function* () {
    const stored = yield* state.tracker.list(sessionID)
    const current = yield* Ref.get(state.known)
    const entries = stored.map((attachment) => entryOf(current, attachment))
    const stacks = agreedStacks(entries).map((stack) => stack.members)

    if (!group(stored, stacks).changed) return { entries, sessionID }
    // A failed regroup leaves the stored order as it was.
    const regrouped = Effect.orElseSucceed(state.tracker.regroup(sessionID, stacks), () => stored)
    const tracking = yield* regrouped

    return { entries: tracking.map((attachment) => entryOf(current, attachment)), sessionID }
  })
}

function publish(state: State, sessionID: string): Effect.Effect<void> {
  return viewOf(state, sessionID).pipe(
    Effect.flatMap((view: SessionView) => PubSub.publish(state.published, view)),
    Effect.ignore,
  )
}

const use = (state: State, sessionID: string): Effect.Effect<void> =>
  Ref.update(state.working, (sessions: ReadonlySet<string>) => new Set(sessions).add(sessionID))

function poll(state: State): Effect.Effect<void> {
  return Effect.gen(function* () {
    const sessions = [...(yield* Ref.get(state.working))]
    // Taken before listing attachments: statuses recorded after this belong to newer attachments.
    const known = yield* Ref.get(state.known)

    const trackings = yield* Effect.forEach(sessions, (sessionID: string) =>
      state.tracker.list(sessionID).pipe(Effect.orElseSucceed((): Tracking => [])),
    )

    const attached = new Map(
      trackings.flat().map((attachment) => [attachment.ref.url, attachment.ref]),
    )

    const now = yield* currentMillis
    // Choose from the cache as it is now: an attach may have recorded a report while listing.
    const current = yield* Ref.get(state.known)
    const due = [...attached.values()].filter((ref: PullRequestRef) => isDue(current, now, ref))

    yield* Ref.update(state.known, (entries: ReadonlyMap<string, Known>) =>
      withoutUnattached(entries, known, attached),
    )

    if (due.length === 0) return

    yield* state.fetch(due)

    const dueUrls = new Set(due.map((ref) => ref.url))

    const affected = sessions.filter((_, index) =>
      urlsOf(trackings[index] ?? []).some((url) => dueUrls.has(url)),
    )

    yield* Effect.forEach(affected, (sessionID: string) => publish(state, sessionID), {
      discard: true,
    })
  })
}

/** Fetches the session's pull requests that `select` picks, then publishes and returns its view. */
function fetchAndShow(
  state: State,
  sessionID: string,
  select: (known: Option.Option<Known>) => boolean,
): Effect.Effect<SessionView, StoredStateInvalid> {
  return Effect.gen(function* () {
    yield* use(state, sessionID)

    const tracking = yield* state.tracker.list(sessionID)
    const known = yield* Ref.get(state.known)

    yield* state.fetch(
      tracking
        .map((attachment) => attachment.ref)
        .filter((ref) => select(Option.fromNullishOr(known.get(ref.url)))),
    )
    const view = yield* viewOf(state, sessionID)

    yield* PubSub.publish(state.published, view)

    return view
  })
}

const refreshable = (known: Option.Option<Known>): boolean =>
  Option.isSome(Option.getOrElse(known, () => unknown).dueAt)

const notYetKnown = (known: Option.Option<Known>): boolean => Option.isNone(known)

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
      tracker: yield* Tracker,
      working: yield* Ref.make<ReadonlySet<string>>(new Set()),
    }

    return Monitor.of({
      changes: Stream.fromPubSub(state.published),
      forget: (sessionID) =>
        Ref.update(
          state.working,
          (sessions: ReadonlySet<string>) =>
            new Set([...sessions].filter((id) => id !== sessionID)),
        ),
      poll: poll(state),
      attached: (sessionID, ref, report) =>
        Effect.andThen(
          remember(cache, new Map([[ref.url, { _tag: "Reported", report }]])),
          fetchAndShow(state, sessionID, notYetKnown),
        ),
      refresh: (sessionID) => fetchAndShow(state, sessionID, refreshable),
      show: (sessionID) => fetchAndShow(state, sessionID, notYetKnown),
      view: (sessionID) => Effect.andThen(use(state, sessionID), viewOf(state, sessionID)),
    })
  }),
)
