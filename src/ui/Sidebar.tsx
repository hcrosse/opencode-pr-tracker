/** @jsxImportSource @opentui/solid */
import type { RGBA } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import { Data, Match, Option } from "effect"
import { For, Show } from "solid-js"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import { layout } from "../domain/StackLayout.ts"
import type { View } from "../rpc.ts"
import type { FailureReason } from "../tui/Client.ts"
import type { Palette } from "./Palette.ts"
import { SidebarRow, type SidebarEntry } from "./Row.tsx"

/**
 * Whether the shown pull requests are current. They are stale when the server may have stopped
 * refreshing the session, because its lease was not renewed in time, or when an update may have
 * been missed. Stale rows stay shown, since they may still be right.
 */
export type Liveness = Data.TaggedEnum<{
  Live: Record<never, never>
  Stale: Record<never, never>
}>

export const Liveness = Data.taggedEnum<Liveness>()

/** What the sidebar knows about its session. */
export type SidebarState = Data.TaggedEnum<{
  Loading: Record<never, never>
  Ready: { readonly view: View; readonly liveness: Liveness }
  Failed: { readonly reason: FailureReason; readonly message: string }
}>

export const SidebarState = Data.taggedEnum<SidebarState>()

const failureNotes: Record<FailureReason, string> = {
  AuthenticationRequired: "sign in needed",
  Failed: "failed",
  GitHubCliMissing: "gh missing",
  GitHubUnavailable: "GitHub unavailable",
  InvalidResponse: "bad response",
  NotFound: "not found",
  NotRunning: "not running",
  RateLimited: "rate limited",
  StoredStateInvalid: "unreadable state",
  TimedOut: "timed out",
  UnreadableResponse: "unreadable response",
}

/** A short status after the heading, in its color. */
interface Note {
  readonly text: string
  readonly color: RGBA
}

const noteOf = (state: SidebarState, palette: Palette): Option.Option<Note> =>
  SidebarState.$match(state, {
    Failed: ({ reason }) =>
      Option.some({ color: palette.tones.yellow, text: failureNotes[reason] }),
    Loading: () => Option.some({ color: palette.muted, text: "loading" }),
    Ready: ({ liveness }) =>
      Liveness.$is("Stale")(liveness)
        ? Option.some({ color: palette.tones.yellow, text: "stale" })
        : Option.none(),
  })

/** Lists longer than this can be collapsed from the heading. */
const collapsibleAbove = 2

const entriesOf = (view: View): SidebarEntry[] =>
  view.entries.map((entry) => ({
    membership: Option.fromNullishOr(entry.membership),
    ref: entry.ref,
    status: entry.status,
  }))

function Heading(props: {
  readonly note: Option.Option<Note>
  readonly collapsible: boolean
  readonly collapsed: boolean
  readonly palette: Palette
  readonly onToggle: () => void
}): JSX.Element {
  return (
    <box
      flexDirection="row"
      gap={1}
      onMouseDown={() => {
        if (props.collapsible) props.onToggle()
      }}
    >
      <Show when={props.collapsible}>
        <text fg={props.palette.text}>{props.collapsed ? "▶" : "▼"}</text>
      </Show>
      <text fg={props.palette.text}>
        <b>Pull requests</b>
        <Show when={Option.getOrUndefined(props.note)}>
          {(note) => (
            <>
              <span style={{ fg: props.palette.muted }}>{" · "}</span>
              <span style={{ fg: note().color }}>{note().text}</span>
            </>
          )}
        </Show>
      </text>
    </box>
  )
}

function Rows(props: {
  readonly view: View
  readonly palette: Palette
  readonly onOpen: (ref: PullRequestRef) => void
}): JSX.Element {
  return (
    <Show
      fallback={<text fg={props.palette.muted}>No pull requests attached</text>}
      when={props.view.entries.length > 0}
    >
      <box flexDirection="column">
        <For each={layout(entriesOf(props.view))}>
          {(row) => (
            <SidebarRow
              compact={props.view.layout === "compact"}
              onOpen={props.onOpen}
              palette={props.palette}
              row={row}
            />
          )}
        </For>
      </box>
    </Show>
  )
}

export function Sidebar(props: {
  readonly state: SidebarState
  readonly collapsed: boolean
  readonly palette: Palette
  readonly onToggle: () => void
  readonly onOpen: (ref: PullRequestRef) => void
}): JSX.Element {
  const collapsible = (): boolean =>
    SidebarState.$is("Ready")(props.state) && props.state.view.entries.length > collapsibleAbove

  const body = (): JSX.Element =>
    Match.valueTags(props.state, {
      Failed: ({ message }) => <text fg={props.palette.muted}>{message}</text>,
      Loading: () => null,
      Ready: ({ view }) => <Rows onOpen={props.onOpen} palette={props.palette} view={view} />,
    })

  return (
    <box flexDirection="column" gap={1}>
      <Heading
        collapsed={props.collapsed}
        collapsible={collapsible()}
        note={noteOf(props.state, props.palette)}
        onToggle={props.onToggle}
        palette={props.palette}
      />
      <Show
        when={!SidebarState.$is("Loading")(props.state) && (!collapsible() || !props.collapsed)}
      >
        {body()}
      </Show>
    </box>
  )
}
