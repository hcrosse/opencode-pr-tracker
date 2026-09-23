/** @jsxImportSource @opentui/solid */
import { usePlugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import { Effect } from "effect"
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import { paletteOf } from "../ui/Palette.ts"
import { Sidebar, type SidebarState } from "../ui/Sidebar.tsx"
import type { TrackerClientApi } from "./Client.ts"

/** Which sessions' lists are collapsed, kept for the plugin's lifetime so it survives remounts. */
export interface Collapsed {
  readonly has: (sessionID: string) => boolean
  readonly toggle: (sessionID: string) => void
}

/**
 * The session's view, owned by the server: listed when the sidebar is shown or switches session,
 * then replaced by each published update.
 */
function sessionView(
  sessionID: Accessor<string>,
  tracker: TrackerClientApi,
  run: (effect: Effect.Effect<void>) => void,
): Accessor<SidebarState> {
  const [state, setState] = createSignal<SidebarState>({ _tag: "Loading" })

  const show = (shownFor: string, next: SidebarState): void => {
    if (sessionID() === shownFor) setState(next)
  }

  onCleanup(
    tracker.onUpdate((view) => {
      show(view.sessionID, { _tag: "Ready", view })
    }),
  )

  createEffect(
    on(sessionID, (current) => {
      setState({ _tag: "Loading" })
      run(
        Effect.map(Effect.result(tracker.list(current)), (result) => {
          if (result._tag === "Failure")
            show(current, { _tag: "Failed", message: result.failure.message })
          // An update may have arrived first; it is at least as new as this answer.
          else if (state()._tag !== "Ready") show(current, { _tag: "Ready", view: result.success })
        }),
      )
    }),
  )

  return state
}

export function SessionSidebar(props: {
  readonly sessionID: string
  readonly tracker: TrackerClientApi
  readonly collapsed: Collapsed
  readonly onOpen: (ref: PullRequestRef) => void
  readonly run: (effect: Effect.Effect<void>) => void
}): JSX.Element {
  const context = usePlugin()
  const state = sessionView(() => props.sessionID, props.tracker, props.run)

  return (
    <Sidebar
      collapsed={props.collapsed.has(props.sessionID)}
      onOpen={props.onOpen}
      onToggle={() => {
        props.collapsed.toggle(props.sessionID)
      }}
      palette={paletteOf(context.theme)}
      state={state()}
    />
  )
}
