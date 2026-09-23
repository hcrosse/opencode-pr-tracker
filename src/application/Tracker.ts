import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect"

import type { PullRequestInput, PullRequestRef } from "../domain/PullRequest.ts"
import { Diagnostic } from "../domain/Snapshot.ts"
import {
  attach,
  detach,
  detachNumber,
  type AmbiguousPullRequestNumber,
  type AttachmentLimitReached,
  type Removal,
  type Tracking,
} from "../domain/Tracking.ts"
import {
  GitHub,
  type GitHubApi,
  type GitHubFailure,
  type ItemResult,
  type Report,
  type RepositoryUnavailable,
} from "../ports/GitHub.ts"
import {
  TrackingRepository,
  type StoredStateInvalid,
  type TrackingRepositoryApi,
} from "../ports/TrackingRepository.ts"

/** GitHub could not report the pull request being attached. */
export class PullRequestUnavailable extends Schema.TaggedError<PullRequestUnavailable>()(
  "PullRequestUnavailable",
  { diagnostic: Diagnostic, url: Schema.String },
) {}

/** GitHub reported only part of the pull request's Stack, so attaching all of it is impossible. */
export class StackIncomplete extends Schema.TaggedError<StackIncomplete>()("StackIncomplete", {
  url: Schema.String,
}) {}

export type AttachFailure =
  | AttachmentLimitReached
  | StackIncomplete
  | GitHubFailure
  | PullRequestUnavailable
  | RepositoryUnavailable
  | StoredStateInvalid

export interface Attached {
  /** The pull request that was named; its Stack may have brought others with it. */
  readonly ref: PullRequestRef
  /** What GitHub reported for it while attaching. */
  readonly report: Report
  readonly changed: boolean
  readonly tracking: Tracking
}

export interface TrackerApi {
  readonly list: (sessionID: string) => Effect.Effect<Tracking, StoredStateInvalid>
  /** Attaches a pull request, with its whole Stack. A bare number is resolved in `directory`. */
  readonly attach: (
    sessionID: string,
    input: PullRequestInput,
    directory: string,
  ) => Effect.Effect<Attached, AttachFailure>
  readonly detach: (
    sessionID: string,
    input: PullRequestInput,
  ) => Effect.Effect<Removal, StoredStateInvalid | AmbiguousPullRequestNumber>
  /** Removes everything stored for a session. Safe to repeat. */
  readonly forget: (sessionID: string) => Effect.Effect<void>
}

export class Tracker extends Context.Service<Tracker, TrackerApi>()(
  "opencode-pr-tracker/Tracker",
) {}

interface Discovered {
  readonly report: Report
  /** The pull request's Stack, bottom first; just the pull request when it has none. */
  readonly stack: Arr.NonEmptyReadonlyArray<PullRequestRef>
}

function discovered(
  ref: PullRequestRef,
  result: ItemResult,
): Effect.Effect<Discovered, PullRequestUnavailable | StackIncomplete> {
  if (result._tag === "Failed")
    return Effect.fail(new PullRequestUnavailable({ diagnostic: result.diagnostic, url: ref.url }))

  const { report } = result

  return Option.match(report.membership, {
    onNone: () => Effect.fail(new StackIncomplete({ url: ref.url })),
    onSome: (membership) =>
      Effect.succeed({
        report,
        stack: membership._tag === "Stack" ? membership.members : Arr.of(ref),
      }),
  })
}

/** Runs one session's operations one at a time, in the order they were requested. */
function sessionLocks(): (
  sessionID: string,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
  const locks = new Map<string, Semaphore.Semaphore>()

  return (sessionID) => (effect) =>
    Effect.suspend(() => {
      const lock = locks.get(sessionID) ?? Semaphore.makeUnsafe(1)

      locks.set(sessionID, lock)

      return lock.withPermit(effect)
    })
}

interface Services {
  readonly github: GitHubApi
  readonly repository: TrackingRepositoryApi
}

function resolve(
  { github }: Services,
  input: PullRequestInput,
  directory: string,
): Effect.Effect<PullRequestRef, GitHubFailure | RepositoryUnavailable> {
  return input._tag === "Reference"
    ? Effect.succeed(input.ref)
    : github.pullRequestInRepository(directory, input.number)
}

const attachTo = Effect.fn("Tracker.attach")(function* (
  services: Services,
  sessionID: string,
  target: Readonly<{ input: PullRequestInput; directory: string }>,
) {
  const ref = yield* resolve(services, target.input, target.directory)
  const reports = yield* services.github.fetch([ref])
  const missing: ItemResult = { _tag: "Failed", diagnostic: "NotFound" }
  const { report, stack } = yield* discovered(ref, reports.get(ref.url) ?? missing)
  const current = yield* services.repository.load(sessionID)
  const change = yield* Effect.fromResult(attach(current, stack, yield* Clock.currentTimeMillis))

  if (change.changed) yield* services.repository.save(sessionID, change.tracking)

  return { changed: change.changed, ref, report, tracking: change.tracking }
})

const detachFrom = Effect.fn("Tracker.detach")(function* (
  { repository }: Services,
  sessionID: string,
  input: PullRequestInput,
) {
  const current = yield* repository.load(sessionID)

  const removal: Removal =
    input._tag === "Reference"
      ? detach(current, input.ref)
      : yield* Effect.fromResult(detachNumber(current, input.number))

  if (Option.isSome(removal.removed)) yield* repository.save(sessionID, removal.tracking)

  return removal
})

export const layer = Layer.effect(
  Tracker,
  Effect.gen(function* () {
    const services: Services = { github: yield* GitHub, repository: yield* TrackingRepository }
    const locked = sessionLocks()

    return Tracker.of({
      attach: (sessionID, input, directory) =>
        locked(sessionID)(attachTo(services, sessionID, { directory, input })),
      detach: (sessionID, input) => locked(sessionID)(detachFrom(services, sessionID, input)),
      forget: (sessionID) => locked(sessionID)(services.repository.remove(sessionID)),
      list: (sessionID) => services.repository.load(sessionID),
    })
  }),
)
