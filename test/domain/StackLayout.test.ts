import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Array as Arr, Option } from "effect"

import type { PullRequestRef } from "../../src/domain/PullRequest.ts"
import {
  agreedStacks,
  layout,
  type Entry,
  Membership,
  Row,
  type StackMembership,
} from "../../src/domain/StackLayout.ts"
import { Attachment, group, type Tracking } from "../../src/domain/Tracking.ts"
import {
  consistentEntries,
  entry,
  pooledRefs,
  rendered,
  worlds,
  type World,
} from "../support/stacks.ts"

const pullRequestRows = (rows: readonly Row<Entry>[]): Entry[] =>
  rows.flatMap((row) => (Row.$is("PullRequest")(row) ? [row.entry] : []))

const anyMembership = gs.oneOf<Option.Option<Membership>>(
  gs.just(Option.none()),
  gs.just(Option.some(Membership.cases.Standalone.make({}))),
  gs
    .tuples(gs.sampledFrom(["a", "b"]), pooledRefs, gs.arrays(pooledRefs))
    .map(([id, head, tail]: readonly [string, PullRequestRef, readonly PullRequestRef[]]) =>
      Option.some(Membership.cases.Stack.make({ id, members: [head, ...tail] })),
    ),
)

/** What a consistent world implies for one row, stated from the world rather than the layout. */
interface Drawn {
  readonly world: World
  readonly entries: readonly Entry[]
  readonly rows: readonly Row<Entry>[]
}

function checkRow({ entries, rows, world }: Drawn, row: Row<Entry>, index: number): void {
  if (Row.$is("Gap")(row)) return

  const members = world.stackOf(row.entry.ref).map((member) => member.url)
  const position = members.indexOf(row.entry.ref.url)
  const attached = entries.filter((other) => members.includes(other.ref.url))
  const step = attached.indexOf(row.entry)

  const skipped = Option.match(Arr.get(attached, step - 1), {
    onNone: () => 0,
    onSome: (before) => position - members.indexOf(before.ref.url) - 1,
  })

  const gap = Option.match(Arr.get(rows, index - 1), {
    onNone: () => 0,
    onSome: (before) => (Row.$is("Gap")(before) ? before.count : 0),
  })

  expect(row.marker === "bullet").toBe(members.length === 1)
  expect(gap).toBe(skipped)

  if (row.marker === "first") expect(position).toBe(0)

  if (row.marker === "last") expect(position).toBe(members.length - 1)

  if (row.marker === "openFirst") expect(position).toBeGreaterThan(0)

  if (row.marker === "openLast") expect(position).toBeLessThan(members.length - 1)

  if (row.marker === "alone") expect(attached).toHaveLength(1)

  if (members.length > 1) expect(row.connector === "continues").toBe(step < attached.length - 1)
}

describe("layout of any entries", () => {
  test("shows every entry exactly once, in order, whatever membership it reports", () => {
    hegel.test((tc) => {
      const entries = tc.draw(gs.arrays(gs.record({ membership: anyMembership, ref: pooledRefs })))
      const rows = layout(entries)

      expect(pullRequestRows(rows)).toEqual(entries)
      expect(
        rows.every((row: Row<Entry>) =>
          Row.$match(row, { Gap: ({ count }) => count > 0, PullRequest: () => true }),
        ),
      ).toBe(true)
    })
  })
})

describe("layout of consistent Stacks", () => {
  test("draws consistent Stacks with boundaries, connectors and gaps", () => {
    hegel.test((tc) => {
      const world = tc.draw(worlds)
      const entries = consistentEntries(tc, world)
      const rows = layout(entries)

      tc.note(rendered(rows).join(", "))

      for (const [index, row] of rows.entries()) checkRow({ entries, rows, world }, row, index)
    })
  })

  test("marks a fully attached Stack from first to last", () => {
    hegel.test((tc) => {
      const { primary } = tc.draw(worlds)

      const rows = layout(
        primary.map((member) =>
          entry(member, Membership.cases.Stack.make({ id: "s", members: primary })),
        ),
      )

      expect(rendered(rows)).toEqual([
        "first/continues",
        ...primary.slice(2).map(() => "middle/continues"),
        "last/none",
      ])
    })
  })
})

/** Pull requests drawn with a Stack marker. */
const drawnInStacks = (rows: readonly Row<Entry>[]): Set<string> =>
  new Set(
    rows.flatMap((row) =>
      Row.$is("PullRequest")(row) && row.marker !== "bullet" ? [row.entry.ref.url] : [],
    ),
  )

/** The attached members of `stacks`. */
const attachedMembers = (
  stacks: readonly StackMembership[],
  entries: readonly Entry[],
): Set<string> => {
  const attached = new Set(entries.map((candidate) => candidate.ref.url))

  return new Set(
    stacks.flatMap((agreed) =>
      agreed.members.flatMap((member) => (attached.has(member.url) ? [member.url] : [])),
    ),
  )
}

interface ContradictoryRows {
  readonly before: readonly Row<Entry>[]
  readonly others: readonly Row<Entry>[]
  readonly primary: readonly Row<Entry>[]
}

function contradictoryRows(tc: hegel.TestCase): ContradictoryRows {
  const world = tc.draw(worlds)
  // Disagreement needs two reports, so keep two primary members attached.
  const entries = consistentEntries(tc, world, 2)

  const inPrimary = (candidate: Entry): boolean =>
    world.primary.some((member) => member.url === candidate.ref.url)

  const target = tc.draw(gs.sampledFrom(entries.filter((candidate) => inPrimary(candidate))))

  const reversed = world.primary.toReversed()

  const contradiction = Membership.cases.Stack.make({
    id: world.primary[0].url,
    members: [reversed[0] ?? world.primary[0], ...reversed.slice(1)],
  })

  const corrupted = entries.map((candidate) =>
    candidate === target ? entry(candidate.ref, contradiction) : candidate,
  )

  // Other Stacks draw as if the primary members were standalone pull requests.
  const unstacked = entries.map((candidate) =>
    inPrimary(candidate) ? entry(candidate.ref, Membership.cases.Standalone.make({})) : candidate,
  )

  const before = layout(unstacked).filter(
    (row) => Row.$is("PullRequest")(row) && !inPrimary(row.entry),
  )

  const after = layout(corrupted)

  return {
    before,
    others: after.filter((row) => Row.$is("PullRequest")(row) && !inPrimary(row.entry)),
    primary: after.filter((row) => Row.$is("PullRequest")(row) && inPrimary(row.entry)),
  }
}

describe("agreed Stacks after grouping", () => {
  test("are all drawn once grouped, however their members were attached", () => {
    hegel.test((tc) => {
      const world = tc.draw(worlds)

      const drawnRefs = tc.draw(
        gs.arrays(gs.oneOf(gs.sampledFrom([...world.primary]), pooledRefs), { maxSize: 20 }),
      )

      const scattered = Arr.dedupeWith(drawnRefs, (left, right) => left.url === right.url).map(
        (ref) => Attachment.make({ attachedAt: 0, ref }),
      )

      const entriesOf = (tracking: Tracking): Entry[] =>
        tracking.map((attachment) => entry(attachment.ref, world.membership(attachment.ref)))

      const agreed = agreedStacks(entriesOf(scattered))

      const grouped = group(
        scattered,
        agreed.map((agreedStack) => agreedStack.members),
      ).tracking

      expect(drawnInStacks(layout(entriesOf(grouped)))).toEqual(
        attachedMembers(agreed, entriesOf(scattered)),
      )
    })
  })
})

describe("agreed Stacks", () => {
  test("are the Stacks layout draws once their members sit together", () => {
    hegel.test((tc) => {
      const world = tc.draw(worlds)
      const entries = consistentEntries(tc, world)

      expect(drawnInStacks(layout(entries))).toEqual(
        attachedMembers(agreedStacks(entries), entries),
      )
    })
  })
})

describe("layout of contradictory Stacks", () => {
  test("demotes only the Stack whose members disagree", () => {
    hegel.test((tc) => {
      const { before, others, primary } = contradictoryRows(tc)

      expect(rendered(primary).every((drawn) => drawn === "bullet/none")).toBe(true)
      expect(rendered(others)).toEqual(rendered(before))
    })
  })
})
