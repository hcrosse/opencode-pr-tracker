// oxlint-disable max-lines -- attach and group share the placement check, so their tests stay together.
import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Array as Arr, Option, Result } from "effect"

import { parsePullRequestUrl, type PullRequestRef } from "../../src/domain/PullRequest.ts"
import {
  attach,
  detach,
  detachNumber,
  group,
  maximumAttachments,
  type Tracking,
} from "../../src/domain/Tracking.ts"
import type { Stack } from "../support/stacks.ts"

/** Few repositories and numbers, so operations collide: duplicates, overlaps, shared numbers. */
const pooledRefs = gs.composite((tc) => {
  const repository = tc.draw(gs.sampledFrom(["acme/api", "acme/web", "other/api"]))
  const number = tc.draw(gs.integers({ maxValue: 30, minValue: 1 }))

  return Result.getOrThrow(parsePullRequestUrl(`github.com/${repository}/pull/${String(number)}`))
})

type Operation =
  | { readonly kind: "attach"; readonly stack: Stack }
  | { readonly kind: "detach"; readonly ref: PullRequestRef }
  | { readonly kind: "detachNumber"; readonly number: number }

const stacks = (maxSize: number): gs.Generator<Stack> =>
  gs
    .tuples(pooledRefs, gs.arrays(pooledRefs, { maxSize }))
    .map(([head, tail]: readonly [PullRequestRef, readonly PullRequestRef[]]): Stack =>
      Arr.prepend(tail, head),
    )

const acmeRef = (number: number): PullRequestRef =>
  Result.getOrThrow(parsePullRequestUrl(`github.com/acme/api/pull/${String(number)}`))

const operations: gs.Generator<Operation> = gs.oneOf<Operation>(
  stacks(5).map((stack) => ({ kind: "attach", stack })),
  pooledRefs.map((ref) => ({ kind: "detach", ref })),
  gs.integers({ maxValue: 31, minValue: 1 }).map((number) => ({ kind: "detachNumber", number })),
)

const urls = (tracking: Tracking): string[] => tracking.map((attachment) => attachment.ref.url)

function uniqueUrls(refs: readonly PullRequestRef[]): string[] {
  return [...new Set(refs.map((ref) => ref.url))]
}

/** The Stack is contiguous, in Stack order, at its earliest member's former place; others keep order. */
function checkPlacement(
  before: readonly string[],
  after: readonly string[],
  members: readonly string[],
): void {
  const others = before.filter((url) => !members.includes(url))
  const firstMember = before.findIndex((url) => members.includes(url))

  const othersBefore =
    firstMember === -1
      ? others.length
      : before.slice(0, firstMember).filter((url) => !members.includes(url)).length

  const start = othersBefore

  expect(after.slice(start, start + members.length)).toEqual([...members])
  expect(after.filter((url) => !members.includes(url))).toEqual(others)
}

/** Existing attachments keep their time; new members are attached `now`. */
function checkTimes(before: Tracking, after: Tracking, now: number): void {
  for (const attachment of after) {
    const previous = Arr.findFirst(before, (existing) => existing.ref.url === attachment.ref.url)

    expect(attachment.attachedAt).toBe(
      Option.match(previous, { onNone: () => now, onSome: (found) => found.attachedAt }),
    )
  }
}

function checkAttach(before: Tracking, stack: Stack, now: number): Tracking {
  const members = uniqueUrls(stack)
  const result = attach(before, stack, now)

  if (new Set([...urls(before), ...members]).size > maximumAttachments) {
    expect(Result.isFailure(result)).toBe(true)

    return before
  }

  const { changed, tracking } = Result.getOrThrow(result)

  checkPlacement(urls(before), urls(tracking), members)
  checkTimes(before, tracking, now)

  expect(changed).toBe(JSON.stringify(urls(tracking)) !== JSON.stringify(urls(before)))

  return tracking
}

function checkDetachNumber(before: Tracking, number: number): Tracking {
  const matches = urls(before).filter((url) => url.endsWith(`/pull/${String(number)}`))
  const result = detachNumber(before, number)

  if (matches.length > 1) {
    const failure = Result.flip(result).pipe(Result.getOrThrow)

    expect(failure.matches.map((ref) => ref.url)).toEqual(matches)

    return before
  }

  const { removed, tracking } = Result.getOrThrow(result)

  expect(Option.map(removed, (ref) => ref.url)).toEqual(Option.fromNullishOr(matches[0]))
  expect(urls(tracking)).toEqual(urls(before).filter((url) => !matches.includes(url)))

  return tracking
}

function checkDetach(before: Tracking, ref: PullRequestRef): Tracking {
  const { removed, tracking } = detach(before, ref)

  expect(Option.isSome(removed)).toBe(urls(before).includes(ref.url))
  expect(urls(tracking)).toEqual(urls(before).filter((url) => url !== ref.url))

  return tracking
}

function apply(before: Tracking, operation: Operation, now: number): Tracking {
  if (operation.kind === "attach") return checkAttach(before, operation.stack, now)

  if (operation.kind === "detach") return checkDetach(before, operation.ref)

  return checkDetachNumber(before, operation.number)
}

describe("Tracking operation sequences", () => {
  test("every operation sequence meets each operation's postconditions", () => {
    hegel.test((tc) => {
      let tracking: Tracking = []

      for (const [step, operation] of tc.draw(gs.arrays(operations)).entries()) {
        tc.note(`step ${String(step)}: ${JSON.stringify(operation)}`)
        tracking = apply(tracking, operation, step)

        expect(new Set(urls(tracking)).size).toBe(tracking.length)
        expect(tracking.length).toBeLessThanOrEqual(maximumAttachments)
      }
    })
  })
})

describe("attaching stacks", () => {
  test("attaching the same stack twice changes nothing the second time", () => {
    hegel.test((tc) => {
      const stack = tc.draw(stacks(maximumAttachments - 1))
      const first = Result.getOrThrow(attach([], stack, 1))
      const second = Result.getOrThrow(attach(first.tracking, stack, 2))

      expect(second).toEqual({ changed: false, tracking: first.tracking })
    })
  })

  test("repeating members within a stack is the same as listing each once", () => {
    hegel.test((tc) => {
      const stack = tc.draw(stacks(8))
      const repeats = tc.draw(gs.arrays(gs.sampledFrom(stack)))
      let before: Tracking = []

      for (const attached of tc.draw(gs.arrays(pooledRefs, { maxSize: maximumAttachments }))) {
        const next = attach(before, [attached], 0)

        if (Result.isSuccess(next)) before = next.success.tracking
      }

      const [head, ...tail] = stack.filter(
        (member, index) => stack.findIndex((other) => other.url === member.url) === index,
      )

      const unique: Stack = [head ?? stack[0], ...tail]

      expect(attach(before, [...stack, ...repeats], 1)).toEqual(attach(before, unique, 1))
    })
  })
})

/** Attaches each pull request on its own, in order, skipping repeats. */
function attachedOneByOne(refs: readonly PullRequestRef[]): Tracking {
  let tracking: Tracking = []

  for (const [step, ref] of refs.entries()) {
    const next = attach(tracking, [ref], step)

    if (Result.isSuccess(next)) tracking = next.success.tracking
  }

  return tracking
}

/** Attachments in any order, as when Stacks are linked after their members were attached. */
const scattered = gs
  .arrays(pooledRefs, { maxSize: maximumAttachments })
  .map((refs: readonly PullRequestRef[]) => attachedOneByOne(refs))

describe("grouping stacks", () => {
  test("gathers a stack's attached members at the earliest of them, and nothing else moves", () => {
    hegel.test((tc) => {
      const before = tc.draw(scattered)
      const stack = tc.draw(stacks(8))
      const { changed, tracking } = group(before, [stack])
      const attached = uniqueUrls(stack).filter((url) => urls(before).includes(url))

      checkPlacement(urls(before), urls(tracking), attached)

      expect(tracking.length).toBe(before.length)
      expect(tracking.every((attachment) => before.includes(attachment))).toBe(true)
      expect(changed).toBe(JSON.stringify(urls(tracking)) !== JSON.stringify(urls(before)))
    })
  })

  test("grouping again changes nothing", () => {
    hegel.test((tc) => {
      const before = tc.draw(scattered)
      const chosen = tc.draw(gs.arrays(stacks(5), { maxSize: 3 }))
      const once = group(before, chosen).tracking

      expect(group(once, chosen)).toEqual({ changed: false, tracking: once })
    })
  })
})

describe("grouping examples", () => {
  test("keeps the first of overlapping stacks, so grouping settles", () => {
    const [a, b, c] = [acmeRef(1), acmeRef(2), acmeRef(3)] as const
    const before = attachedOneByOne([a, b, c])

    const overlapping = [
      [a, b],
      [b, c],
      [c, a],
    ]

    const once = group(before, overlapping)

    expect(once.tracking.map((attachment) => attachment.ref.number)).toEqual([1, 2, 3])
    expect(group(once.tracking, overlapping).changed).toBe(false)
  })

  test("groups a stack whose members were linked after they were attached", () => {
    const attached = [1925, 1927, 1928, 1929, 1931, 1932, 1934, 1937, 1935, 1938, 1943]
    const before = attachedOneByOne(attached.map((number) => acmeRef(number)))
    const linked = [1927, 1928, 1929, 1937, 1938].map((number) => acmeRef(number))
    const { changed, tracking } = group(before, [linked])

    expect(changed).toBe(true)
    expect(tracking.map((attachment) => attachment.ref.number)).toEqual([
      1925, 1927, 1928, 1929, 1937, 1938, 1931, 1932, 1934, 1935, 1943,
    ])
  })
})

describe("Tracking examples", () => {
  test("counts a repeated stack member once against the limit", () => {
    let tracking: Tracking = []

    for (let number = 1; number < maximumAttachments; number += 1) {
      tracking = Result.getOrThrow(attach(tracking, [acmeRef(number)], 0)).tracking
    }

    const result = attach(tracking, [acmeRef(99), acmeRef(99)], 1)

    expect(Result.map(result, (change) => change.tracking.length)).toEqual(
      Result.succeed(maximumAttachments),
    )
  })

  test("attaching a stack member moves the whole stack to that member's place", () => {
    const standalone = Result.getOrThrow(attach([], [acmeRef(1)], 1)).tracking
    const middle = Result.getOrThrow(attach(standalone, [acmeRef(3)], 2)).tracking
    const withTail = Result.getOrThrow(attach(middle, [acmeRef(9)], 3)).tracking

    const stacked = Result.getOrThrow(
      attach(withTail, [acmeRef(2), acmeRef(3), acmeRef(4)], 4),
    ).tracking

    expect(stacked.map((attachment) => attachment.ref.number)).toEqual([1, 2, 3, 4, 9])
    expect(stacked.map((attachment) => attachment.attachedAt)).toEqual([1, 4, 2, 4, 3])
  })
})
