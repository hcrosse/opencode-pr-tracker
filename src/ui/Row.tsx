/** @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { Match, Option } from "effect"
import { createSignal, For, Show } from "solid-js"

import { appearance, type Appearance } from "../domain/Appearance.ts"
import type { PullRequestRef } from "../domain/PullRequest.ts"
import type { Status } from "../domain/Snapshot.ts"
import type { Connector, Entry, Marker, Row } from "../domain/StackLayout.ts"
import type { Palette } from "./Palette.ts"

export interface SidebarEntry extends Entry {
  readonly status: Status
}

/** A glyph drawn in the marker column: the Stack line in muted color, the status tick in `color`. */
interface Glyph {
  readonly line: string
  readonly tick: string
}

const markers: Record<Marker, Glyph> = {
  bullet: { line: "", tick: "•" },
  first: { line: "┌", tick: "─" },
  last: { line: "└", tick: "─" },
  middle: { line: "├", tick: "─" },
}

/** What continues the marker column under a row: the Stack line, a gap to unattached members, or space. */
const continuations: Record<Connector, Glyph> = {
  continues: { line: "│", tick: "" },
  none: { line: "", tick: "" },
  open: { line: "┊", tick: "" },
}

const markerWidth = 3

/** What `Marked` reads from its text renderable: how many lines the text wraps to. */
interface LineCount {
  readonly virtualLineCount: number
}

function MarkerGlyph(props: {
  readonly glyph: Glyph
  readonly palette: Palette
  readonly color: RGBA
}): JSX.Element {
  const padding = (): string =>
    " ".repeat(markerWidth - props.glyph.line.length - props.glyph.tick.length)

  return (
    <text>
      <span style={{ fg: props.palette.muted }}>{props.glyph.line}</span>
      <span style={{ fg: props.color }}>{props.glyph.tick}</span>
      {padding()}
    </text>
  )
}

/** Text beside a marker column. Wrapped lines repeat `rest` so Stack lines stay unbroken. */
function Marked(props: {
  readonly first: Glyph
  readonly rest: Glyph
  readonly palette: Palette
  readonly color: RGBA
  readonly children: JSX.Element
}): JSX.Element {
  const [lines, setLines] = createSignal(1)
  let content: Option.Option<LineCount> = Option.none()

  const measure = (): void => {
    const count = Option.match(content, {
      onNone: () => 1,
      onSome: (text) => text.virtualLineCount,
    })

    setLines(Math.max(1, count))
  }

  return (
    <box flexDirection="row" width="100%">
      <box flexDirection="column" width={markerWidth}>
        <MarkerGlyph color={props.color} glyph={props.first} palette={props.palette} />
        <For each={Array.from({ length: lines() - 1 })}>
          {() => <MarkerGlyph color={props.color} glyph={props.rest} palette={props.palette} />}
        </For>
      </box>
      <text
        flexGrow={1}
        on:line-info-change={measure}
        ref={(text: LineCount) => {
          content = Option.some(text)
          measure()
        }}
      >
        {props.children}
      </text>
    </box>
  )
}

const titleOf = (status: Status): string =>
  Match.valueTags(status, {
    Fresh: ({ snapshot }) => snapshot.title,
    Pending: () => "Loading title",
    Stale: ({ snapshot }) => snapshot.title,
    Unavailable: () => "Title unavailable",
  })

export function PullRequestRow(props: {
  readonly entry: SidebarEntry
  readonly marker: Marker
  readonly connector: Connector
  readonly compact: boolean
  readonly palette: Palette
  readonly onOpen: (ref: PullRequestRef) => void
}): JSX.Element {
  const shown = (): Appearance => appearance(props.entry.status)
  const color = (): RGBA => props.palette.tones[shown().tone]

  const below = (): Glyph => continuations[props.connector]

  return (
    <box
      flexDirection="column"
      onMouseUp={() => {
        props.onOpen(props.entry.ref)
      }}
    >
      <Marked color={color()} first={markers[props.marker]} palette={props.palette} rest={below()}>
        <span style={{ bold: true, fg: color(), strikethrough: shown().strikethrough }}>
          {props.entry.ref.label}
        </span>
        <span style={{ fg: color() }}>{` ${shown().label}`}</span>
        <Show when={shown().stale}>
          <span style={{ fg: props.palette.muted, italic: true }}>{" · stale"}</span>
        </Show>
      </Marked>
      <Show when={!props.compact}>
        <Marked color={color()} first={below()} palette={props.palette} rest={below()}>
          <span style={{ fg: props.palette.muted, strikethrough: shown().strikethrough }}>
            {titleOf(props.entry.status)}
          </span>
        </Marked>
      </Show>
    </box>
  )
}

export function GapRow(props: { readonly count: number; readonly palette: Palette }): JSX.Element {
  const label = (): string =>
    `${String(props.count)} ${props.count === 1 ? "PR" : "PRs"} not attached`

  return <text fg={props.palette.muted}>{`├┄ ${label()}`}</text>
}

export function SidebarRow(props: {
  readonly row: Row<SidebarEntry>
  readonly compact: boolean
  readonly palette: Palette
  readonly onOpen: (ref: PullRequestRef) => void
}): JSX.Element {
  return Match.valueTags(props.row, {
    Gap: ({ count }) => <GapRow count={count} palette={props.palette} />,
    PullRequest: ({ connector, entry, marker }) => (
      <PullRequestRow
        compact={props.compact}
        connector={connector}
        entry={entry}
        marker={marker}
        onOpen={props.onOpen}
        palette={props.palette}
      />
    ),
  })
}
