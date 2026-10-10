import { describe, expect, test } from "bun:test"

import { agreedStacks, layout, Membership, type Entry } from "../../src/domain/StackLayout.ts"
import { entry, ref, rendered, type Stack } from "../support/stacks.ts"

const members: Stack = [
  ref("acme/api", 1),
  ref("acme/api", 2),
  ref("acme/api", 3),
  ref("acme/api", 4),
  ref("acme/api", 5),
]

const attachedAt = (positions: readonly number[]): Entry[] =>
  positions.map((position) =>
    entry(members[position] ?? members[0], Membership.cases.Stack.make({ id: "s", members })),
  )

describe("layout of a partly attached Stack", () => {
  test.each<readonly [string, readonly number[], readonly string[]]>([
    ["the base alone", [0], ["middle/open"]],
    ["the head alone", [4], ["middle/none"]],
    ["a middle member alone", [2], ["middle/open"]],
    ["base and head", [0, 4], ["first/continues", "gap 3", "last/none"]],
    [
      "a single internal gap",
      [1, 3, 4],
      ["middle/continues", "gap 1", "middle/continues", "last/none"],
    ],
    ["no gap outside the attached range", [1, 2], ["middle/continues", "middle/open"]],
  ])("marks %s", (_name, positions, expected) => {
    expect(rendered(layout(attachedAt(positions)))).toEqual([...expected])
  })
})

describe("layout of several Stacks", () => {
  test("keeps two Stacks in one repository separate", () => {
    const second: Stack = [ref("acme/api", 6), ref("acme/api", 7)]

    const entries = [
      ...attachedAt([0, 1]),
      ...second.map((member) =>
        entry(member, Membership.cases.Stack.make({ id: "t", members: second })),
      ),
    ]

    expect(rendered(layout(entries))).toEqual([
      "first/continues",
      "openLast/open",
      "first/continues",
      "last/none",
    ])
  })

  // A pull request moving between Stacks can be listed by both for a refresh.
  test("draws neither Stack while two Stacks both list one pull request", () => {
    const moved = ref("acme/api", 3)
    const first: Stack = [ref("acme/api", 1), ref("acme/api", 2), moved]
    const second: Stack = [moved, ref("acme/api", 4)]

    const entries = [
      ...first
        .slice(0, 2)
        .map((member) => entry(member, Membership.cases.Stack.make({ id: "s", members: first }))),
      entry(ref("acme/api", 4), Membership.cases.Stack.make({ id: "t", members: second })),
    ]

    expect(rendered(layout(entries))).toEqual(["bullet/none", "bullet/none", "bullet/none"])
  })
})

const other: Stack = [ref("acme/web", 1), ref("acme/web", 2), ref("acme/web", 3)]

const otherAt = (positions: readonly number[]): Entry[] =>
  positions.map((position) =>
    entry(other[position] ?? other[0], Membership.cases.Stack.make({ id: "t", members: other })),
  )

describe("layout of touching Stacks", () => {
  test.each<readonly [string, readonly Entry[], readonly string[]]>([
    ["lone members of each", [...attachedAt([2]), ...otherAt([1])], ["alone/open", "alone/open"]],
    [
      "partial Stacks open toward each other",
      [...attachedAt([0, 1]), ...otherAt([1, 2])],
      ["first/continues", "openLast/open", "openFirst/continues", "last/none"],
    ],
    [
      "a true head beside an open base",
      [...attachedAt([3, 4]), ...otherAt([1, 2])],
      ["middle/continues", "last/none", "openFirst/continues", "last/none"],
    ],
    [
      "a lone base beside a lone head",
      [...attachedAt([0]), ...otherAt([2])],
      ["alone/open", "alone/none"],
    ],
  ])("closes the touching edges of %s", (_name, entries, expected) => {
    expect(rendered(layout(entries))).toEqual([...expected])
  })

  test("keeps open edges that only touch a standalone pull request", () => {
    const entries = [
      ...attachedAt([0, 1]),
      entry(ref("acme/web", 9), Membership.cases.Standalone.make({})),
    ]

    expect(rendered(layout(entries))).toEqual(["first/continues", "middle/open", "bullet/none"])
  })
})

describe("layout of inconsistent membership", () => {
  test.each([
    [
      "a member reports standalone",
      [...attachedAt([0, 1]), entry(ref("acme/api", 3), Membership.cases.Standalone.make({}))],
    ],
    [
      "a standalone pull request splits the Stack",
      [
        ...attachedAt([0]),
        entry(ref("acme/web", 1), Membership.cases.Standalone.make({})),
        ...attachedAt([1]),
      ],
    ],
    ["members are attached in reverse order", attachedAt([1, 0])],
  ])("falls back to bullets when %s", (_name: string, entries: readonly Entry[]) => {
    expect(rendered(layout(entries)).every((drawn) => drawn === "bullet/none")).toBe(true)
  })
})

describe("agreed Stacks with a reporter it does not list", () => {
  test("agrees on nothing while an attached member reports a Stack without it", () => {
    const [first, second] = members
    const reportedStack: Stack = [first, second ?? first]
    const outsider = ref("acme/api", 9)

    const entries = [
      entry(first, Membership.cases.Stack.make({ id: "s", members: reportedStack })),
      entry(outsider, Membership.cases.Stack.make({ id: "s", members: reportedStack })),
      entry(second ?? first, Membership.cases.Standalone.make({})),
    ]

    expect(agreedStacks(entries)).toEqual([])
  })
})
