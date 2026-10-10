import { describe, expect, test } from "bun:test"

import { Effect, Exit, Option } from "effect"

import type { Attached, TrackerApi } from "../../src/application/Tracker.ts"
import { PullRequestInput, type PullRequestRef } from "../../src/domain/PullRequest.ts"
import { PullRequestState } from "../../src/domain/Snapshot.ts"
import { Membership } from "../../src/domain/StackLayout.ts"
import { maximumAttachments } from "../../src/domain/Tracking.ts"
import { attachedMessage } from "../../src/messages.ts"
import { ItemResult } from "../../src/ports/GitHub.ts"
import { openState, reported, standalone } from "../support/application.ts"
import { numbers, ref, refs, run, world, type World } from "../support/tracker.ts"

interface Outcome {
  readonly message: string
  readonly tracking: readonly number[]
}

const outcome = (attached: Attached): Outcome => ({
  message: attachedMessage(attached),
  tracking: numbers(attached.tracking),
})

/** Scripts a Stack of `members`, bottom first, where `merged` and `closed` are not open. */
function scriptStack(
  setup: World,
  members: readonly number[],
  ended: Readonly<{ merged: readonly number[]; closed: readonly number[] }>,
): void {
  const [bottom = 1, ...rest] = members
  const stack = Membership.cases.Stack.make({ id: "s", members: [ref(bottom), ...refs(rest)] })
  const nonOpen = refs([...ended.merged, ...ended.closed])

  const stateOf = (member: PullRequestRef): PullRequestState => {
    if (ended.merged.includes(member.number)) return PullRequestState.cases.Merged.make({})

    return ended.closed.includes(member.number) ? PullRequestState.cases.Closed.make({}) : openState
  }

  for (const member of refs(members)) {
    setup.github.script(
      member,
      ItemResult.Reported({
        report: {
          membership: Option.some(stack),
          nonOpenMembers: nonOpen.map((found: PullRequestRef) => found.url),
          snapshot: { ref: member, state: stateOf(member), title: member.label },
        },
      }),
    )
  }
}

const attachEach = (
  tracker: TrackerApi,
  attaching: readonly number[],
): Effect.Effect<readonly Outcome[], unknown> =>
  Effect.forEach(refs(attaching), (member: PullRequestRef) =>
    Effect.map(
      tracker.attach("session", PullRequestInput.Reference({ ref: member }), "/work"),
      outcome,
    ),
  )

/** A Stack of 1 to 6 where 1 and 5 are merged and 3 is closed. */
function mixedStack(): World {
  const setup = world()

  scriptStack(setup, [1, 2, 3, 4, 5, 6], { closed: [3], merged: [1, 5] })

  return setup
}

async function attachToMixedStack(
  attaching: readonly number[],
): Promise<Exit.Exit<readonly Outcome[], unknown>> {
  const result = await run(mixedStack(), (tracker: TrackerApi) => attachEach(tracker, attaching))

  return result
}

const last = (
  result: Exit.Exit<readonly Outcome[], unknown>,
): Exit.Exit<Outcome | undefined, unknown> =>
  Exit.map(result, (outcomes: readonly Outcome[]) => outcomes.at(-1))

describe("Tracker attach with a Stack's merged and closed members", () => {
  test("attaches an open member with only the Stack's open members, bottom first", async () => {
    expect(await attachToMixedStack([4])).toEqual(
      Exit.succeed([
        {
          message:
            "Attached acme/api#4. 3 of its Stack's 6 pull requests are attached. The other 3 are merged or closed.",
          tracking: [2, 4, 6],
        },
      ]),
    )
  })

  test("attaches a merged or closed member when it is named", async () => {
    expect(last(await attachToMixedStack([5, 3]))).toEqual(
      Exit.succeed({
        message:
          "Attached acme/api#3. 5 of its Stack's 6 pull requests are attached. The other one is merged or closed.",
        tracking: [2, 3, 4, 5, 6],
      }),
    )
  })

  test("keeps an attached merged member when another member is attached", async () => {
    expect(last(await attachToMixedStack([1, 4]))).toEqual(
      Exit.succeed({ message: "acme/api#4 is already attached.", tracking: [1, 2, 4, 6] }),
    )
  })

  test("keeps attached merged members in Stack order when an open member is attached again", async () => {
    expect(last(await attachToMixedStack([1, 3, 2]))).toEqual(
      Exit.succeed({ message: "acme/api#2 is already attached.", tracking: [1, 2, 3, 4, 6] }),
    )
  })
})

describe("Tracker attach messages for Stacks", () => {
  test("says so when every other member is merged or closed", async () => {
    const setup = world()

    scriptStack(setup, [1, 2, 3], { closed: [3], merged: [1] })

    expect(await run(setup, (tracker: TrackerApi) => attachEach(tracker, [2]))).toEqual(
      Exit.succeed([
        {
          message: "Attached acme/api#2. The rest of its Stack is merged or closed.",
          tracking: [2],
        },
      ]),
    )
  })

  test("names the whole Stack once every member is attached", async () => {
    expect(last(await attachToMixedStack([1, 3, 5]))).toEqual(
      Exit.succeed({
        message: "Attached acme/api#5 with the rest of its Stack (6 pull requests).",
        tracking: [1, 2, 3, 4, 5, 6],
      }),
    )
  })

  test("attaches the whole Stack when every member is open", async () => {
    const setup = world()

    scriptStack(setup, [1, 2, 3], { closed: [], merged: [] })

    expect(await run(setup, (tracker: TrackerApi) => attachEach(tracker, [2]))).toEqual(
      Exit.succeed([
        {
          message: "Attached acme/api#2 with the rest of its Stack (3 pull requests).",
          tracking: [1, 2, 3],
        },
      ]),
    )
  })
})

describe("Tracker attach with inconsistent or large Stacks", () => {
  test("attaches a pull request alone when its Stack does not list it", async () => {
    const setup = world()
    const stack = Membership.cases.Stack.make({ id: "s", members: [ref(1), ref(2)] })

    setup.github.script(ref(3), reported(ref(3), openState, stack))

    expect(await run(setup, (tracker: TrackerApi) => attachEach(tracker, [3]))).toEqual(
      Exit.succeed([{ message: "Attached acme/api#3.", tracking: [3] }]),
    )
  })

  test("counts only the members it attaches against the limit", async () => {
    const setup = mixedStack()
    const others = Array.from({ length: maximumAttachments - 3 }, (_, index: number) => index + 7)

    for (const other of refs(others)) {
      setup.github.script(other, reported(other, openState, standalone))
    }

    const result = await run(setup, (tracker: TrackerApi) => attachEach(tracker, [...others, 4]))

    const sizes = Exit.map(result, (outcomes: readonly Outcome[]) =>
      outcomes.map((each: Outcome) => each.tracking.length),
    )

    expect(Exit.map(sizes, (counts: readonly number[]) => counts.at(-1))).toEqual(
      Exit.succeed(maximumAttachments),
    )
  })
})
