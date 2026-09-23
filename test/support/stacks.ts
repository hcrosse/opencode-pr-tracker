import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Array as Arr, Option, Result } from "effect"

import { parsePullRequestUrl, type PullRequestRef } from "../../src/domain/PullRequest.ts"
import type { Entry, Membership, Row } from "../../src/domain/StackLayout.ts"
import { attach, detach, type Tracking } from "../../src/domain/Tracking.ts"

export type Stack = readonly [PullRequestRef, ...PullRequestRef[]]

export const ref = (repository: string, number: number): PullRequestRef =>
  Result.getOrThrow(parsePullRequestUrl(`github.com/${repository}/pull/${String(number)}`))

export const pooledRefs = gs.composite((tc) =>
  ref(
    tc.draw(gs.sampledFrom(["acme/api", "acme/web"])),
    tc.draw(gs.integers({ maxValue: 24, minValue: 1 })),
  ),
)

export const stack = (id: string, members: Stack): Membership => ({ _tag: "Stack", id, members })

export const entry = (member: PullRequestRef, membership: Membership): Entry => ({
  membership: Option.some(membership),
  ref: member,
})

/** Each row as `marker/connector`, or `gap N`. */
export const rendered = (rows: readonly Row<Entry>[]): string[] =>
  rows.map((row) =>
    row._tag === "Gap" ? `gap ${String(row.count)}` : `${row.marker}/${row.connector}`,
  )

/** Distinct pull requests split into Stacks and standalone pull requests. */
export interface World {
  readonly membership: (member: PullRequestRef) => Membership
  readonly stackOf: (member: PullRequestRef) => readonly PullRequestRef[]
  /** A Stack of at least two members, attached before any other operation. */
  readonly primary: Stack
}

const primaryStacks = gs
  .sets(gs.integers({ maxValue: 99, minValue: 50 }), { maxSize: 8, minSize: 2 })
  .map((numbers) => [...numbers].map((number) => ref("acme/api", number)))
  .map((refs: readonly PullRequestRef[]): Stack =>
    Arr.prepend(refs.slice(1), refs[0] ?? ref("acme/api", 50)),
  )

export const worlds = gs.composite((tc): World => {
  const primary = tc.draw(primaryStacks)

  const byUrl = new Map<string, readonly PullRequestRef[]>(
    primary.map((member) => [member.url, primary]),
  )

  let rest = Arr.dedupeWith(tc.draw(gs.arrays(pooledRefs)), (left, right) => left.url === right.url)

  while (rest.length > 0) {
    const group = rest.slice(0, tc.draw(gs.integers({ maxValue: 5, minValue: 1 })))

    for (const member of group) byUrl.set(member.url, group)
    rest = rest.slice(group.length)
  }

  const stackOf = (member: PullRequestRef): readonly PullRequestRef[] =>
    byUrl.get(member.url) ?? [member]

  const membership = (member: PullRequestRef): Membership =>
    Arr.matchLeft(stackOf(member), {
      onEmpty: (): Membership => ({ _tag: "Standalone" }),
      onNonEmpty: (head: PullRequestRef, tail: readonly PullRequestRef[]): Membership =>
        tail.length === 0 ? { _tag: "Standalone" } : stack(head.url, [head, ...tail]),
    })

  return { membership, primary, stackOf }
})

/** Attaches a pull request the way a user does: with the rest of its Stack. */
function attachWhole(tracking: Tracking, members: readonly PullRequestRef[], at: number): Tracking {
  return Arr.matchLeft(members, {
    onEmpty: () => tracking,
    onNonEmpty: (head: PullRequestRef, tail: readonly PullRequestRef[]) =>
      Result.match(attach(tracking, [head, ...tail], at), {
        onFailure: () => tracking,
        onSuccess: (change) => change.tracking,
      }),
  })
}

/**
 * Attachments made through the production aggregate. The primary Stack is attached, then
 * partly detached (its first `keep` members stay), then random attaches and detaches follow.
 */
export function attachments(tc: hegel.TestCase, world: World, keep = 0): Tracking {
  let tracking = attachWhole([], world.primary, 0)

  for (const member of world.primary.slice(keep)) {
    if (tc.draw(gs.booleans())) tracking = detach(tracking, member).tracking
  }

  for (const [step, attaching] of tc.draw(gs.arrays(gs.booleans())).entries()) {
    const detachable = tracking.slice(keep)

    if (attaching) tracking = attachWhole(tracking, world.stackOf(tc.draw(pooledRefs)), step + 1)
    else if (detachable.length > 0) {
      tracking = detach(tracking, tc.draw(gs.sampledFrom(detachable)).ref).tracking
    }
  }

  return tracking
}

export const consistentEntries = (tc: hegel.TestCase, world: World, keep = 0): Entry[] =>
  attachments(tc, world, keep).map((attachment) =>
    entry(attachment.ref, world.membership(attachment.ref)),
  )
