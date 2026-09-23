/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { Effect, Option } from "effect"
import { createSignal } from "solid-js"

import { layer as commandLayer } from "./adapters/Command.ts"
import { PullRequestTracker } from "./rpc.ts"
import { actions } from "./tui/Actions.ts"
import { openUrl, type OpenFailed } from "./tui/Browser.ts"
import { makeClient, type Location } from "./tui/Client.ts"
import { Commands } from "./tui/Commands.tsx"
import { SessionSidebar, type Collapsed } from "./tui/SessionSidebar.tsx"
import { hostTerminal } from "./tui/Terminal.ts"

const open = (url: string): Effect.Effect<void, OpenFailed> =>
  openUrl(url, process.platform).pipe(Effect.provide(commandLayer))

const locationOfSession = (session: { readonly location?: Location }): Option.Option<Location> =>
  Option.fromNullishOr(session.location)

function collapsedSessions(): Collapsed {
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set())

  return {
    has: (sessionID) => collapsed().has(sessionID),
    toggle: (sessionID) => {
      const next = new Set(collapsed())

      if (!next.delete(sessionID)) next.add(sessionID)
      setCollapsed(next)
    },
  }
}

export default Plugin.define({
  id: "opencode-pr-tracker",
  setup(context) {
    const tracker = makeClient({
      locationOf: (sessionID) =>
        Option.fromNullishOr(context.data.session.get(sessionID)).pipe(
          Option.flatMap(locationOfSession),
          Option.orElse(() => Option.fromNullishOr(context.location)),
        ),
      rpc: context.client.rpc(PullRequestTracker),
    })

    const { dismiss, terminal } = hostTerminal(context.ui)
    const commands = actions({ open, terminal, tracker })
    const collapsed = collapsedSessions()

    const disposers = [
      context.ui.slot({ append: "app", render: () => <Commands actions={commands} /> }),
      context.ui.slot({
        append: "sidebar.content",
        render: ({ sessionID }) => (
          <SessionSidebar
            collapsed={collapsed}
            onOpen={(ref) => {
              Effect.runFork(commands.openPullRequest(ref))
            }}
            sessionID={sessionID}
            tracker={tracker}
          />
        ),
      }),
    ]

    return (): void => {
      for (const dispose of disposers) dispose()
      dismiss()
    }
  },
})
