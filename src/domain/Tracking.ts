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

function identity(tracking: Tracking): string {
  return tracking
    .map((attachment) => `${attachment.ref.url} ${String(attachment.attachedAt)}`)
    .join("\n")
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
  const others = tracking.filter((attachment) => !isMember(members, attachment))
  const requested = others.length + members.length

  if (requested > maximumAttachments) {
    return Result.fail(new AttachmentLimitReached({ limit: maximumAttachments, requested }))
  }

  const position = tracking.findIndex((attachment) => isMember(members, attachment))
  const insertAt = position === -1 ? others.length : position

  const placed = members.map((ref) =>
    Option.getOrElse(
      Arr.findFirst(tracking, (attachment) => samePullRequest(attachment.ref, ref)),
      () => new Attachment({ attachedAt: now, ref }),
    ),
  )

  const next = [...others.slice(0, insertAt), ...placed, ...others.slice(insertAt)]

  return Result.succeed({ changed: identity(tracking) !== identity(next), tracking: next })
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
