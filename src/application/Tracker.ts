import { Array as Arr, Context, Effect, Layer, Option, Schema } from "effect"

import {
  samePullRequest,
  type PullRequestInput,
  type PullRequestRef,
} from "../domain/PullRequest.ts"
import { Diagnostic } from "../domain/Snapshot.ts"
import type { Membership } from "../domain/StackLayout.ts"
import {
  attach,
  detach,
  detachNumber,
  group,
  type AmbiguousPullRequestNumber,
  type Attaching,
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
import { SessionLocks } from "./SessionLocks.ts"
import { currentMillis } from "./Time.ts"

/** GitHub could not report the pull request being attached. */
export class PullRequestUnavailable extends Schema.TaggedError<PullRequestUnavailable>()(
  "PullRequestUnavailable",
  { diagnostic: Diagnostic, url: Schema.String },
) {}

/** GitHub reported only part of the pull request's Stack, so which members to attach is unknown. */
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
  /** How many pull requests the named one's Stack has, itself included. */
  readonly stackSize: number
  /** How many of the Stack's pull requests are attached afterwards, the named one included. */
  readonly attachedMembers: number
  readonly tracking: Tracking
}

export interface TrackerApi {
  readonly list: (sessionID: string) => Effect.Effect<Tracking, StoredStateInvalid>
  /**
   * Attaches a pull request with its Stack's open members. Merged or closed members are left out
   * unless named. A bare number is resolved in `directory`.
   */
  readonly attach: (
    sessionID: string,
    input: PullRequestInput,
    directory: string,
  ) => Effect.Effect<Attached, AttachFailure>
  readonly detach: (
    sessionID: string,
    input: PullRequestInput,
  ) => Effect.Effect<Removal, StoredStateInvalid | AmbiguousPullRequestNumber>
  /**
   * Brings each Stack's attached members together, bottom to top, where the earliest of them is
   * attached. Stacks are listed bottom first. Saves only when the order changes.
   */
  readonly regroup: (
    sessionID: string,
    stacks: readonly (readonly PullRequestRef[])[],
  ) => Effect.Effect<Tracking, StoredStateInvalid>
  /** Removes everything stored for a session. Safe to repeat. */
  readonly forget: (sessionID: string) => Effect.Effect<void>
}

export class Tracker extends Context.Service<Tracker, TrackerApi>()(
  "opencode-pr-tracker/Tracker",
) {}

interface Discovered extends Attaching {
  readonly report: Report
}

/**
 * The pull request's Stack, bottom first, with the members to attach: the pull request itself and
 * the Stack's open members. A pull request GitHub does not list among its Stack's members is
 * treated as standalone.
 */
function attaching(
  ref: PullRequestRef,
  membership: Membership,
  nonOpen: readonly string[],
): Attaching {
  const standalone = { adding: [ref], stack: Arr.of(ref) }

  if (membership._tag === "Standalone") return standalone

  const { members } = membership

  if (!members.some((member) => member.url === ref.url)) return standalone

  return {
    adding: members.filter((member) => member.url === ref.url || !nonOpen.includes(member.url)),
    stack: members,
  }
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
    onSome: (membership) => {
      const { adding, stack } = attaching(ref, membership, report.nonOpenMembers)

      return Effect.succeed({ adding, report, stack })
    },
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
  const missing: ItemResult = { _tag: "Failed", charged: false, diagnostic: "NotFound" }
  const { adding, report, stack } = yield* discovered(ref, reports.get(ref.url) ?? missing)
  const current = yield* services.repository.load(sessionID)
  const now = yield* currentMillis
  const change = yield* Effect.fromResult(attach(current, { adding, stack }, now))

  if (change.changed) yield* services.repository.save(sessionID, change.tracking)

  const attached = stack.filter((member) =>
    change.tracking.some((attachment) => samePullRequest(attachment.ref, member)),
  )

  return {
    attachedMembers: attached.length,
    changed: change.changed,
    ref,
    report,
    stackSize: stack.length,
    tracking: change.tracking,
  }
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

const regroupIn = Effect.fn("Tracker.regroup")(function* (
  { repository }: Services,
  sessionID: string,
  stacks: readonly (readonly PullRequestRef[])[],
) {
  const change = group(yield* repository.load(sessionID), stacks)

  if (change.changed) yield* repository.save(sessionID, change.tracking)

  return change.tracking
})

export const layer = Layer.effect(
  Tracker,
  Effect.gen(function* () {
    const services: Services = { github: yield* GitHub, repository: yield* TrackingRepository }
    const locks = new SessionLocks()

    return Tracker.of({
      attach: (sessionID, input, directory) =>
        locks.run(sessionID, attachTo(services, sessionID, { directory, input })),
      detach: (sessionID, input) => locks.run(sessionID, detachFrom(services, sessionID, input)),
      forget: (sessionID) => locks.run(sessionID, services.repository.remove(sessionID)),
      list: (sessionID) => services.repository.load(sessionID),
      regroup: (sessionID, stacks) => locks.run(sessionID, regroupIn(services, sessionID, stacks)),
    })
  }),
)
