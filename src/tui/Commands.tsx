/** @jsxImportSource @opentui/solid */
import { usePlugin } from "@opencode/plugin/tui"
import type { KeymapCommand } from "@opencode/plugin/tui/context"
import type { JSX } from "@opentui/solid"
import { Effect, Fiber, Option } from "effect"
import { onCleanup } from "solid-js"

import type { Actions } from "./Actions.ts"

interface Definition {
  readonly name: string
  readonly title: string
  /** Whether the slash command passes what follows it, as `/pr-attach 123` does. */
  readonly takesInput: boolean
  readonly act: (input: Option.Option<string>) => Effect.Effect<void>
}

const definitions = (actions: Actions): readonly Definition[] => [
  { act: actions.attach, name: "attach", takesInput: true, title: "Attach pull request" },
  { act: () => actions.open, name: "open", takesInput: false, title: "Open pull request" },
  { act: () => actions.detach, name: "detach", takesInput: false, title: "Detach pull request" },
  { act: () => actions.sync, name: "sync", takesInput: false, title: "Sync pull request status" },
]

function command(
  definition: Definition,
  run: (effect: Effect.Effect<void>) => void,
): KeymapCommand {
  const slash = definition.takesInput
    ? { arguments: true as const, name: `pr-${definition.name}` }
    : { name: `pr-${definition.name}` }

  return {
    group: "Pull requests",
    id: `pr.${definition.name}`,
    palette: true,
    run: (input) => {
      run(definition.act(Option.fromNullishOr(input)))
    },
    slash,
    title: definition.title,
  }
}

/** Registers the slash commands; OpenCode requires this from a rendered component. */
export function Commands(props: { readonly actions: Actions }): JSX.Element {
  const context = usePlugin()
  const running = new Set<Fiber.Fiber<void>>()

  const run = (effect: Effect.Effect<void>): void => {
    const fiber = Effect.runFork(effect)

    running.add(fiber)
    fiber.addObserver(() => {
      running.delete(fiber)
    })
  }

  const commands = definitions(props.actions).map((definition) => command(definition, run))

  onCleanup(() => {
    Effect.runFork(Fiber.interruptAll(running))
  })
  context.keymap.layer(() => ({ commands, mode: "global" }))

  return null
}
