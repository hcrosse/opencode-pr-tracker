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

/** Numbers requests; each listing and each published update supersedes the listings before it. */
interface Listings {
  readonly next: () => number
  readonly isLatest: (request: number) => boolean
}

function newestFirst(): Listings {
  let latest = 0

  return {
    isLatest: (request) => request === latest,
    next: () => {
      latest += 1

      return latest
    },
  }
}

/**
 * The session's view, owned by the server: listed when the sidebar is shown or switches session,
 * then replaced by each published update. Answers to superseded listings are ignored.
 */
export function sessionView(
  sessionID: Accessor<string>,
  tracker: TrackerClientApi,
  run: (effect: Effect.Effect<void>) => void,
): Accessor<SidebarState> {
  const [state, setState] = createSignal<SidebarState>({ _tag: "Loading" })
  const requests = newestFirst()

  onCleanup(
    tracker.onUpdate((view) => {
      if (view.sessionID !== sessionID()) return

      requests.next()
      setState({ _tag: "Ready", view })
    }),
  )

  createEffect(
    on(sessionID, (current) => {
      const request = requests.next()

      setState({ _tag: "Loading" })
      run(
        Effect.map(Effect.result(tracker.list(current)), (result) => {
          if (!requests.isLatest(request)) return

          setState(
            result._tag === "Failure"
              ? { _tag: "Failed", message: result.failure.message }
              : { _tag: "Ready", view: result.success },
          )
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
