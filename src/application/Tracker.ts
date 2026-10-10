import { Array as Arr, Context, Effect, Layer, Option, Schema } from "effect"

import { samePullRequest, PullRequestInput, type PullRequestRef } from "../domain/PullRequest.ts"
import { Diagnostic } from "../domain/Snapshot.ts"
import { Membership } from "../domain/StackLayout.ts"
import {
  attach,
  detach,
  detachNumber,
  group,
  type AmbiguousPullRequestNumber,
  type Attaching,
  type AttachmentLimitReached,
  type Change,
  type Removal,
  type Tracking,
} from "../domain/Tracking.ts"
import {
  GitHub,
  ItemResult,
  type GitHubFailure,
  type Report,
  type RepositoryUnavailable,
} from "../ports/GitHub.ts"
import { TrackingRepository, type StoredStateInvalid } from "../ports/TrackingRepository.ts"
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

  return Membership.match(membership, {
    Standalone: () => standalone,
    Stack: ({ members }) =>
      members.some((member) => member.url === ref.url)
        ? {
            adding: members.filter(
              (member) => member.url === ref.url || !nonOpen.includes(member.url),
            ),
            stack: members,
          }
        : standalone,
  })
}

function discovered(
  ref: PullRequestRef,
  result: ItemResult,
): Effect.Effect<Discovered, PullRequestUnavailable | StackIncomplete> {
  if (ItemResult.$is("Failed")(result))
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

function attachedOf(ref: PullRequestRef, { report, stack }: Discovered, change: Change): Attached {
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
}

/** Attaches a pull request with its Stack's open members, as `TrackerApi.attach` describes. */
const attacher = Effect.gen(function* () {
  const github = yield* GitHub
  const repository = yield* TrackingRepository

  const resolve = (
    input: PullRequestInput,
    directory: string,
  ): Effect.Effect<PullRequestRef, GitHubFailure | RepositoryUnavailable> =>
    PullRequestInput.$match(input, {
      Reference: ({ ref }) => Effect.succeed(ref),
      Number: ({ number }) => github.pullRequestInRepository(directory, number),
    })

  return Effect.fn("Tracker.attach")(function* (
    sessionID: string,
    input: PullRequestInput,
    directory: string,
  ) {
    const ref = yield* resolve(input, directory)
    const reports = yield* github.fetch([ref])
    // GitHub answers for every pull request it is asked about; an answer without one is incomplete.
    const missing = ItemResult.Failed({ charged: false, diagnostic: "InvalidResponse" })
    const found = yield* discovered(ref, reports.get(ref.url) ?? missing)
    const current = yield* repository.load(sessionID)
    const now = yield* currentMillis
    const change = yield* Effect.fromResult(attach(current, found, now))

    if (change.changed) yield* repository.save(sessionID, change.tracking)

    return attachedOf(ref, found, change)
  })
})

export const layer = Layer.effect(
  Tracker,
  Effect.gen(function* () {
    const repository = yield* TrackingRepository
    const attachTo = yield* attacher
    const locks = new SessionLocks()

    const detachFrom = Effect.fn("Tracker.detach")(function* (
      sessionID: string,
      input: PullRequestInput,
    ) {
      const current = yield* repository.load(sessionID)

      const removal: Removal = PullRequestInput.$is("Reference")(input)
        ? detach(current, input.ref)
        : yield* Effect.fromResult(detachNumber(current, input.number))

      if (Option.isSome(removal.removed)) yield* repository.save(sessionID, removal.tracking)

      return removal
    })

    const regroupIn = Effect.fn("Tracker.regroup")(function* (
      sessionID: string,
      stacks: readonly (readonly PullRequestRef[])[],
    ) {
      const change = group(yield* repository.load(sessionID), stacks)

      if (change.changed) yield* repository.save(sessionID, change.tracking)

      return change.tracking
    })

    return Tracker.of({
      attach: (sessionID, input, directory) =>
        locks.run(sessionID, attachTo(sessionID, input, directory)),
      detach: (sessionID, input) => locks.run(sessionID, detachFrom(sessionID, input)),
      forget: (sessionID) => locks.run(sessionID, repository.remove(sessionID)),
      list: (sessionID) => repository.load(sessionID),
      regroup: (sessionID, stacks) => locks.run(sessionID, regroupIn(sessionID, stacks)),
    })
  }),
)
