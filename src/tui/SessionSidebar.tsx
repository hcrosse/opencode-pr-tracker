/** @jsxImportSource @opentui/solid */
import { usePlugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import { paletteOf } from "../ui/Palette.ts"
import { Sidebar } from "../ui/Sidebar.tsx"
import type { Run } from "./Background.ts"
import type { TrackerClientApi } from "./Client.ts"
import { sessionView } from "./SessionView.ts"

/** Which sessions' lists are collapsed, kept for the plugin's lifetime so it survives remounts. */
export interface Collapsed {
  readonly has: (sessionID: string) => boolean
  readonly toggle: (sessionID: string) => void
}

export function SessionSidebar(props: {
  readonly sessionID: string
  readonly tracker: TrackerClientApi
  readonly collapsed: Collapsed
  readonly onOpen: (ref: PullRequestRef) => void
  readonly run: Run
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
