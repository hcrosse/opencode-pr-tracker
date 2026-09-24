import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Array as Arr, Option } from "effect"

import type { PullRequestRef } from "../../src/domain/PullRequest.ts"
import {
  agreedStacks,
  layout,
  type Entry,
  type Membership,
  type Row,
} from "../../src/domain/StackLayout.ts"
import { Attachment, group, type Tracking } from "../../src/domain/Tracking.ts"
import {
  consistentEntries,
  entry,
  pooledRefs,
  rendered,
  stack,
  worlds,
  type World,
} from "../support/stacks.ts"

const pullRequestRows = (rows: readonly Row<Entry>[]): Entry[] =>
  rows.flatMap((row) => (row._tag === "PullRequest" ? [row.entry] : []))

const anyMembership = gs.oneOf<Option.Option<Membership>>(
  gs.just(Option.none()),
  gs.just(Option.some({ _tag: "Standalone" })),
  gs
    .tuples(gs.sampledFrom(["a", "b"]), pooledRefs, gs.arrays(pooledRefs))
    .map(([id, head, tail]: readonly [string, PullRequestRef, readonly PullRequestRef[]]) =>
      Option.some(stack(id, [head, ...tail])),
    ),
)

/** What a consistent world implies for one row, stated from the world rather than the layout. */
interface Drawn {
  readonly world: World
  readonly entries: readonly Entry[]
  readonly rows: readonly Row<Entry>[]
}

function checkRow({ entries, rows, world }: Drawn, row: Row<Entry>, index: number): void {
  if (row._tag === "Gap") return

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
    onSome: (before) => (before._tag === "Gap" ? before.count : 0),
  })

  expect(row.marker === "bullet").toBe(members.length === 1)
  expect(gap).toBe(skipped)

  if (row.marker === "first") expect(position).toBe(0)

  if (row.marker === "last") expect(position).toBe(members.length - 1)

  if (members.length > 1) expect(row.connector === "continues").toBe(step < attached.length - 1)
}

describe("layout of any entries", () => {
  test("shows every entry exactly once, in order, whatever membership it reports", () => {
    hegel.test((tc) => {
      const entries = tc.draw(gs.arrays(gs.record({ membership: anyMembership, ref: pooledRefs })))
      const rows = layout(entries)

      expect(pullRequestRows(rows)).toEqual(entries)
      expect(rows.every((row: Row<Entry>) => row._tag === "PullRequest" || row.count > 0)).toBe(
        true,
      )
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
      const rows = layout(primary.map((member) => entry(member, stack("s", primary))))

      expect(rendered(rows)).toEqual([
        "first/continues",
        ...primary.slice(2).map(() => "middle/continues"),
        "last/none",
      ])
    })
  })
})

describe("agreed Stacks after grouping", () => {
  test("are all drawn once grouped, however their members were attached", () => {
    hegel.test((tc) => {
      const world = tc.draw(worlds)

      const drawnRefs = tc.draw(
        gs.arrays(gs.oneOf(gs.sampledFrom([...world.primary]), pooledRefs), { maxSize: 20 }),
      )

      const scattered = Arr.dedupeWith(drawnRefs, (left, right) => left.url === right.url).map(
        (ref) => new Attachment({ attachedAt: 0, ref }),
      )

      const entriesOf = (tracking: Tracking): Entry[] =>
        tracking.map((attachment) => entry(attachment.ref, world.membership(attachment.ref)))

      const agreed = agreedStacks(entriesOf(scattered))

      const grouped = group(
        scattered,
        agreed.map((agreedStack) => agreedStack.members),
      ).tracking

      const drawn = layout(entriesOf(grouped)).flatMap((row) =>
        row._tag === "PullRequest" && row.marker !== "bullet" ? [row.entry.ref.url] : [],
      )

      const attached = new Set(scattered.map((attachment) => attachment.ref.url))

      const members = agreed.flatMap((agreedStack) =>
        agreedStack.members.flatMap((member) => (attached.has(member.url) ? [member.url] : [])),
      )

      expect(new Set(drawn)).toEqual(new Set(members))
    })
  })
})

describe("agreed Stacks", () => {
  test("are the Stacks layout draws once their members sit together", () => {
    hegel.test((tc) => {
      const world = tc.draw(worlds)
      const entries = consistentEntries(tc, world)

      const drawn = layout(entries).flatMap((row) =>
        row._tag === "PullRequest" && row.marker !== "bullet" ? [row.entry.ref.url] : [],
      )

      const attached = new Set(entries.map((candidate) => candidate.ref.url))

      const agreed = agreedStacks(entries).flatMap((agreedStack) =>
        agreedStack.members.flatMap((member) => (attached.has(member.url) ? [member.url] : [])),
      )

      expect(new Set(agreed)).toEqual(new Set(drawn))
    })
  })
})

describe("layout of contradictory Stacks", () => {
  test("demotes only the Stack whose members disagree", () => {
    hegel.test((tc) => {
      const world = tc.draw(worlds)
      // Disagreement needs two reports, so keep two primary members attached.
      const entries = consistentEntries(tc, world, 2)

      const inPrimary = (candidate: Entry): boolean =>
        world.primary.some((member) => member.url === candidate.ref.url)

      const target = tc.draw(gs.sampledFrom(entries.filter((candidate) => inPrimary(candidate))))
      const reversed = world.primary.toReversed()

      const contradiction = stack(world.primary[0].url, [
        reversed[0] ?? world.primary[0],
        ...reversed.slice(1),
      ])

      const corrupted = entries.map((candidate) =>
        candidate === target ? entry(candidate.ref, contradiction) : candidate,
      )

      const before = layout(entries).filter(
        (row) => row._tag === "PullRequest" && !inPrimary(row.entry),
      )

      const after = layout(corrupted)
      const others = after.filter((row) => row._tag === "PullRequest" && !inPrimary(row.entry))
      const primaryRows = after.filter((row) => row._tag === "PullRequest" && inPrimary(row.entry))

      expect(rendered(primaryRows).every((drawn) => drawn === "bullet/none")).toBe(true)
      expect(rendered(others)).toEqual(rendered(before))
    })
  })
})
