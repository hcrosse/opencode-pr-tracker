import { Array as Arr, Option, Schema } from "effect"

import { PullRequestRef } from "./PullRequest.ts"

/** GitHub Stack membership. Members are listed bottom to top. */
export const Membership = Schema.Union([
  Schema.TaggedStruct("Standalone", {}),
  Schema.TaggedStruct("Stack", {
    id: Schema.String,
    members: Schema.NonEmptyArray(PullRequestRef),
  }),
])

export type Membership = typeof Membership.Type

export type StackMembership = Extract<Membership, { readonly _tag: "Stack" }>

export interface Entry {
  readonly ref: PullRequestRef
  readonly membership: Option.Option<Membership>
}

/** `first`, `middle` and `last` draw a Stack's boundary; `bullet` is an ordinary pull request. */
export type Marker = "bullet" | "first" | "middle" | "last"

/** How the line under a row continues: to the next attached member, to unattached members, or not. */
export type Connector = "continues" | "open" | "none"

export type Row<E extends Entry> =
  | {
      readonly _tag: "PullRequest"
      readonly entry: E
      readonly marker: Marker
      readonly connector: Connector
    }
  | { readonly _tag: "Gap"; readonly count: number }

interface Placed {
  readonly index: number
  readonly position: number
  readonly size: number
}

/** Where one entry sits within its Stack's attached members. */
interface Place {
  readonly current: Placed
  readonly previous: Option.Option<Placed>
  readonly first: boolean
  readonly last: boolean
  readonly attached: number
}

interface Reported {
  readonly index: number
  readonly url: string
  readonly stack: StackMembership
}

const stackOf = (entry: Entry): Option.Option<StackMembership> =>
  Option.filter(entry.membership, (membership) => membership._tag === "Stack")

const urlsOf = (stack: StackMembership): string[] => stack.members.map((member) => member.url)

function reportsById(entries: readonly Entry[]): Map<string, Reported[]> {
  const byId = new Map<string, Reported[]>()

  for (const [index, entry] of entries.entries()) {
    for (const stack of Option.toArray(stackOf(entry))) {
      byId.set(stack.id, [...(byId.get(stack.id) ?? []), { index, stack, url: entry.ref.url }])
    }
  }

  return byId
}

/** Every Stack ID that lists each pull request, across all reported memberships. */
function claims(byId: ReadonlyMap<string, readonly Reported[]>): Map<string, Set<string>> {
  const claimed = new Map<string, Set<string>>()

  for (const [id, reports] of byId) {
    for (const url of reports.flatMap((report) => urlsOf(report.stack))) {
      claimed.set(url, new Set([...(claimed.get(url) ?? []), id]))
    }
  }

  return claimed
}

function agrees(
  reports: readonly Reported[],
  entries: readonly Entry[],
  claimed: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const members = Option.match(Arr.head(reports), {
    onNone: (): string[] => [],
    onSome: (report) => urlsOf(report.stack),
  })

  const listed = new Set(members)
  const attachedMembers = entries.filter((entry) => listed.has(entry.ref.url))

  return (
    listed.size === members.length &&
    reports.every((report) => urlsOf(report.stack).join("\n") === members.join("\n")) &&
    members.every((url) => (claimed.get(url) ?? new Set()).size === 1) &&
    attachedMembers.length === reports.length
  )
}

function placements(reports: readonly Reported[]): Option.Option<Placed[]> {
  const placed = reports.map((report) => ({
    index: report.index,
    position: urlsOf(report.stack).indexOf(report.url),
    size: report.stack.members.length,
  }))

  const adjacent = Arr.zipWith(
    placed,
    placed.slice(1),
    (before: Placed, after: Placed) =>
      after.index === before.index + 1 && after.position > before.position,
  )

  const ordered = placed.every((member: Placed) => member.position >= 0) && adjacent.every(Boolean)

  return ordered ? Option.some(placed) : Option.none()
}

/** The reports of each Stack whose attached members all agree on it, and no other Stack claims. */
function agreedReports(entries: readonly Entry[]): (readonly Reported[])[] {
  const byId = reportsById(entries)
  const claimed = claims(byId)

  return [...byId.values()].filter((reports: readonly Reported[]) =>
    agrees(reports, entries, claimed),
  )
}

/** Stacks the entries report consistently: the ones `layout` can draw once their members sit together. */
export function agreedStacks(entries: readonly Entry[]): StackMembership[] {
  return agreedReports(entries).flatMap((reports: readonly Reported[]) =>
    Option.toArray(Option.map(Arr.head(reports), (report) => report.stack)),
  )
}

/** Each entry that belongs to a consistent Stack, with its place among the attached members. */
function consistentStacks(entries: readonly Entry[]): Map<number, Place> {
  const places = new Map<number, Place>()

  for (const reports of agreedReports(entries)) {
    const placed = placements(reports)

    for (const group of Option.toArray(placed)) {
      for (const [step, current] of group.entries()) {
        places.set(current.index, {
          attached: group.length,
          current,
          first: step === 0,
          last: step === group.length - 1,
          previous: Arr.get(group, step - 1),
        })
      }
    }
  }

  return places
}

function marker(place: Place): Marker {
  const { current } = place

  if (place.attached === 1 && current.size > 1) return "middle"

  if (place.first && current.position === 0) return "first"

  if (place.last && current.position === current.size - 1) return "last"

  return "middle"
}

function connector(place: Place): Connector {
  if (!place.last) return "continues"

  return place.current.position < place.current.size - 1 ? "open" : "none"
}

function stackRows<E extends Entry>(entry: E, place: Place): Row<E>[] {
  const skipped = Option.match(place.previous, {
    onNone: () => 0,
    onSome: (before) => place.current.position - before.position - 1,
  })

  const row: Row<E> = {
    _tag: "PullRequest",
    connector: connector(place),
    entry,
    marker: marker(place),
  }

  return skipped > 0 ? [{ _tag: "Gap", count: skipped }, row] : [row]
}

/** Sidebar rows in attachment order, with Stack markers and gaps where membership is consistent. */
export function layout<E extends Entry>(entries: readonly E[]): Row<E>[] {
  const places = consistentStacks(entries)

  return entries.flatMap((entry, index) =>
    Option.match(Option.fromNullishOr(places.get(index)), {
      onNone: (): Row<E>[] => [{ _tag: "PullRequest", connector: "none", entry, marker: "bullet" }],
      onSome: (place) => stackRows(entry, place),
    }),
  )
}
