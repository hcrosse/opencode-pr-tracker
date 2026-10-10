/** @jsxImportSource @opentui/solid */
import { usePlugin } from "@opencode/plugin/tui"
import type { JSX } from "@opentui/solid"
import { Effect, Schedule } from "effect"
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import { paletteOf } from "../ui/Palette.ts"
import { Sidebar, type SidebarState } from "../ui/Sidebar.tsx"
import type { Interrupt } from "./Background.ts"
import type { TrackerClientApi } from "./Client.ts"

/** Which sessions' lists are collapsed, kept for the plugin's lifetime so it survives remounts. */
export interface Collapsed {
  readonly has: (sessionID: string) => boolean
  readonly toggle: (sessionID: string) => void
}

/** How often a shown session's lease is renewed, well within the server's 45-second lease. */
const renewalInterval = 15_000

/** How long one renewal may take, so a hung call cannot hold back the ones after it. */
const renewalTimeout = 5000

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

/** Renews the session's lease until the owning reactive scope is cleaned up. */
function renewWhileShown(
  sessionID: string,
  tracker: TrackerClientApi,
  run: (effect: Effect.Effect<void>) => Interrupt,
): void {
  // Each renewal starts on a 15-second boundary, never overlaps the previous one and ends within
  // 5 seconds, so successful renewals land at most 20 seconds apart, or 35 after one failed
  // renewal, inside the 45-second lease. Renewal failures are not yet reported: the plugin API has
  // no log sink. A defect stops renewal for that session until it switches or the sidebar remounts.
  const renewals = Effect.schedule(
    Effect.ignore(Effect.timeout(tracker.watch(sessionID), renewalTimeout)),
    Schedule.fixed(renewalInterval),
  )

  onCleanup(run(Effect.asVoid(renewals)))
}

/**
 * The session's view, owned by the server: listed when the sidebar is shown or switches session,
 * then replaced by each published update. Answers to superseded listings are ignored. While the
 * session is shown, its lease is renewed so the server keeps refreshing it.
 */
export function sessionView(
  sessionID: Accessor<string>,
  tracker: TrackerClientApi,
  run: (effect: Effect.Effect<void>) => Interrupt,
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

      renewWhileShown(current, tracker, run)
    }),
  )

  return state
}

export function SessionSidebar(props: {
  readonly sessionID: string
  readonly tracker: TrackerClientApi
  readonly collapsed: Collapsed
  readonly onOpen: (ref: PullRequestRef) => void
  readonly run: (effect: Effect.Effect<void>) => Interrupt
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
