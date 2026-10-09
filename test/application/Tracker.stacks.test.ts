import { describe, expect, test } from "bun:test"

import { Effect, Exit, Option } from "effect"

import type { Attached, TrackerApi } from "../../src/application/Tracker.ts"
import type { PullRequestRef } from "../../src/domain/PullRequest.ts"
import type { Membership } from "../../src/domain/StackLayout.ts"
import { attachedMessage } from "../../src/messages.ts"
import { openState } from "../support/application.ts"
import { byUrl, numbers, ref, refs, run, world, type World } from "../support/tracker.ts"

interface Outcome {
  readonly message: string
  readonly tracking: readonly number[]
}

const outcome = (attached: Attached): Outcome => ({
  message: attachedMessage(attached),
  tracking: numbers(attached.tracking),
})

/** Scripts a Stack of `members`, bottom first, where `nonOpen` are merged or closed. */
function scriptStack(setup: World, members: readonly number[], nonOpen: readonly number[]): void {
  const [bottom = 1, ...rest] = members
  const stack: Membership = { _tag: "Stack", id: "s", members: [ref(bottom), ...refs(rest)] }

  for (const member of refs(members)) {
    const state = nonOpen.includes(member.number) ? { _tag: "Merged" as const } : openState

    setup.github.script(member, {
      _tag: "Reported",
      report: {
        membership: Option.some(stack),
        nonOpenMembers: refs(nonOpen).map((found: PullRequestRef) => found.url),
        snapshot: { ref: member, state, title: member.label },
      },
    })
  }
}

const attachEach = (
  tracker: TrackerApi,
  attaching: readonly number[],
): Effect.Effect<readonly Outcome[], unknown> =>
  Effect.forEach(refs(attaching), (member: PullRequestRef) =>
    Effect.map(tracker.attach("session", byUrl(member), "/work"), outcome),
  )

/** Attaches `attaching` in turn to a Stack of 1 to 6 where 1, 3 and 5 are merged or closed. */
async function attachToMixedStack(
  attaching: readonly number[],
): Promise<Exit.Exit<readonly Outcome[], unknown>> {
  const setup = world()

  scriptStack(setup, [1, 2, 3, 4, 5, 6], [1, 3, 5])

  const result = await run(setup, (tracker: TrackerApi) => attachEach(tracker, attaching))

  return result
}

describe("Tracker attach with a Stack's merged and closed members", () => {
  test("attaches an open member with only the Stack's open members, bottom first", async () => {
    expect(await attachToMixedStack([4])).toEqual(
      Exit.succeed([
        {
          message: "Attached acme/api#4 with the open members of its Stack (3 of 6 pull requests).",
          tracking: [2, 4, 6],
        },
      ]),
    )
  })

  test("attaches a merged member when it is named, with the Stack's open members", async () => {
    expect(await attachToMixedStack([5])).toEqual(
      Exit.succeed([
        {
          message: "Attached acme/api#5 with the open members of its Stack (4 of 6 pull requests).",
          tracking: [2, 4, 5, 6],
        },
      ]),
    )
  })

  test("keeps an attached merged member when another member is attached", async () => {
    const result = await attachToMixedStack([1, 4])

    expect(Exit.map(result, (outcomes: readonly Outcome[]) => outcomes.at(-1))).toEqual(
      Exit.succeed({ message: "acme/api#4 is already attached.", tracking: [1, 2, 4, 6] }),
    )
  })

  test("keeps attached merged members in Stack order when an open member is attached again", async () => {
    const result = await attachToMixedStack([1, 3, 2])

    expect(Exit.map(result, (outcomes: readonly Outcome[]) => outcomes.at(-1))).toEqual(
      Exit.succeed({ message: "acme/api#2 is already attached.", tracking: [1, 2, 3, 4, 6] }),
    )
  })
})

describe("Tracker attach messages for Stacks", () => {
  test("says so when every other member is merged or closed", async () => {
    const setup = world()

    scriptStack(setup, [1, 2, 3], [1, 3])

    const result = await run(setup, (tracker: TrackerApi) => attachEach(tracker, [2]))

    expect(result).toEqual(
      Exit.succeed([
        {
          message: "Attached acme/api#2. The rest of its Stack is merged or closed.",
          tracking: [2],
        },
      ]),
    )
  })

  test("attaches the whole Stack when every member is open", async () => {
    const setup = world()

    scriptStack(setup, [1, 2, 3], [])

    const result = await run(setup, (tracker: TrackerApi) => attachEach(tracker, [2]))

    expect(result).toEqual(
      Exit.succeed([
        {
          message: "Attached acme/api#2 with the rest of its Stack (3 pull requests).",
          tracking: [1, 2, 3],
        },
      ]),
    )
  })
})
