import type { UI } from "@opencode/plugin/tui/context"
import { Effect, Option } from "effect"

import type { Terminal } from "./Actions.ts"

/** A terminal backed by OpenCode's UI; `dismiss` closes a dialog it still has open. */
export interface HostTerminal {
  readonly terminal: Terminal
  readonly dismiss: () => void
}

/** The session on screen, if any. */
function currentSession(ui: UI): Option.Option<string> {
  const route = ui.router.current()

  return route.type === "session" ? Option.some(route.sessionID) : Option.none()
}

export function hostTerminal(ui: UI): HostTerminal {
  let open = false

  /** Shows a dialog, remembering it is open until it answers. */
  const dialog = <A>(show: () => Promise<A | undefined>): Effect.Effect<Option.Option<A>> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        open = true
      }),
      () => Effect.promise(show).pipe(Effect.map(Option.fromNullishOr)),
      () =>
        Effect.sync(() => {
          open = false
        }),
    )

  return {
    dismiss: () => {
      if (open) ui.dialog.clear()
    },
    terminal: {
      choose: (title, choices) =>
        dialog(async () => {
          const chosen = await ui.dialog.select({ options: choices, title })

          return chosen
        }),
      notify: (variant, message) => {
        ui.toast.show({ message, title: "Pull requests", variant })
      },
      prompt: (title, placeholder) =>
        dialog(async () => {
          const answer = await ui.dialog.prompt({ placeholder, title })

          return answer
        }),
      session: () => currentSession(ui),
    },
  }
}
