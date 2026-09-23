/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid"
import { Match, Option } from "effect"
import { For, Show } from "solid-js"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import { layout } from "../domain/StackLayout.ts"
import type { View } from "../rpc.ts"
import type { Palette } from "./Palette.ts"
import { SidebarRow, type SidebarEntry } from "./Row.tsx"

/** What the sidebar knows about its session. */
export type SidebarState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Ready"; readonly view: View }
  | { readonly _tag: "Failed"; readonly message: string }

/** Lists longer than this can be collapsed from the heading. */
const collapsibleAbove = 2

const entriesOf = (view: View): SidebarEntry[] =>
  view.entries.map((entry) => ({
    membership: Option.fromNullishOr(entry.membership),
    ref: entry.ref,
    status: entry.status,
  }))

function Heading(props: {
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
    props.state._tag === "Ready" && props.state.view.entries.length > collapsibleAbove

  const body = (): JSX.Element =>
    Match.valueTags(props.state, {
      Failed: ({ message }) => <text fg={props.palette.tones.red}>{message}</text>,
      Loading: () => <text fg={props.palette.muted}>Loading</text>,
      Ready: ({ view }) => <Rows onOpen={props.onOpen} palette={props.palette} view={view} />,
    })

  return (
    <box flexDirection="column" gap={1}>
      <Heading
        collapsed={props.collapsed}
        collapsible={collapsible()}
        onToggle={props.onToggle}
        palette={props.palette}
      />
      <Show when={!collapsible() || !props.collapsed}>{body()}</Show>
    </box>
  )
}
