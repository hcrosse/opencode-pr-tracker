import { Array as Arr, Option, Result, Schema } from "effect"

import { PullRequestRef, samePullRequest } from "./PullRequest.ts"

export const maximumAttachments = 20

export class Attachment extends Schema.Class<Attachment>("Attachment")({
  attachedAt: Schema.Int,
  ref: PullRequestRef,
}) {}

/** The pull requests attached to one session, in display order. */
export type Tracking = readonly Attachment[]

export class AttachmentLimitReached extends Schema.TaggedError<AttachmentLimitReached>()(
  "AttachmentLimitReached",
  { limit: Schema.Int, requested: Schema.Int },
) {}

export class AmbiguousPullRequestNumber extends Schema.TaggedError<AmbiguousPullRequestNumber>()(
  "AmbiguousPullRequestNumber",
  { matches: Schema.Array(PullRequestRef), number: Schema.Int },
) {}

export interface Change {
  readonly tracking: Tracking
  readonly changed: boolean
}

export interface Removal {
  readonly tracking: Tracking
  readonly removed: Option.Option<PullRequestRef>
}

function isMember(stack: readonly PullRequestRef[], attachment: Attachment): boolean {
  return stack.some((ref) => samePullRequest(ref, attachment.ref))
}

// Attachments are reused as they are, so any change shows as a different element.
const differs = (before: Tracking, after: Tracking): boolean =>
  after.length !== before.length || after.some((attachment, index) => attachment !== before[index])

function groupOne(tracking: Tracking, stack: readonly PullRequestRef[]): Tracking {
  const members = Arr.dedupeWith(stack, samePullRequest)
  // Every attachment before the earliest member is not a member, so this is also its place among the others.
  const insertAt = tracking.findIndex((attachment) => isMember(members, attachment))

  if (insertAt === -1) return tracking

  const others = tracking.filter((attachment) => !isMember(members, attachment))

  const placed = members.flatMap((ref) =>
    Option.toArray(Arr.findFirst(tracking, (attachment) => samePullRequest(attachment.ref, ref))),
  )

  return [...others.slice(0, insertAt), ...placed, ...others.slice(insertAt)]
}

/**
 * Brings each stack's attached members together, bottom to top, where the earliest of them is
 * attached. Other attachments keep their order. Nothing is attached or detached. A stack sharing a
 * member with an earlier one is skipped, since both cannot hold together; this keeps grouping
 * idempotent.
 */
export function group(tracking: Tracking, stacks: readonly (readonly PullRequestRef[])[]): Change {
  const grouped = new Set<string>()
  let next = tracking

  for (const stack of stacks) {
    if (stack.some((ref) => grouped.has(ref.url))) continue

    for (const ref of stack) grouped.add(ref.url)

    next = groupOne(next, stack)
  }

  return { changed: differs(tracking, next), tracking: next }
}

/**
 * Attaches every member of a stack, bottom to top. A single pull request is a stack of one.
 * Members are placed together where the earliest of them was already attached, or at the end.
 */
export function attach(
  tracking: Tracking,
  stack: Arr.NonEmptyReadonlyArray<PullRequestRef>,
  now: number,
): Result.Result<Change, AttachmentLimitReached> {
  const members = Arr.dedupeWith(stack, samePullRequest)

  const missing = members.filter(
    (ref) => !tracking.some((attachment) => samePullRequest(attachment.ref, ref)),
  )

  const requested = tracking.length + missing.length

  if (requested > maximumAttachments) {
    return Result.fail(new AttachmentLimitReached({ limit: maximumAttachments, requested }))
  }

  const appended = [...tracking, ...missing.map((ref) => new Attachment({ attachedAt: now, ref }))]
  const next = group(appended, [members]).tracking

  return Result.succeed({ changed: differs(tracking, next), tracking: next })
}

export function detach(tracking: Tracking, ref: PullRequestRef): Removal {
  const next = tracking.filter((attachment) => !samePullRequest(attachment.ref, ref))
  const removed = next.length === tracking.length ? Option.none() : Option.some(ref)

  return { removed, tracking: next }
}

/** Detaches the only attachment with `number`. Several matches are ambiguous. */
export function detachNumber(
  tracking: Tracking,
  number: number,
): Result.Result<Removal, AmbiguousPullRequestNumber> {
  const matches = tracking.filter((attachment) => attachment.ref.number === number)

  if (matches.length > 1) {
    const refs = matches.map((attachment) => attachment.ref)

    return Result.fail(new AmbiguousPullRequestNumber({ matches: refs, number }))
  }

  return Result.succeed(
    Option.match(Arr.head(matches), {
      onNone: () => ({ removed: Option.none(), tracking }),
      onSome: (attachment) => detach(tracking, attachment.ref),
    }),
  )
}
