import { Effect, Layer, Option } from "effect"

import { CommandFailed, CommandMissing, CommandRunner } from "../../src/adapters/Command.ts"

/** How a fixed command finishes. */
export type FixedOutcome =
  | { readonly _tag: "Output"; readonly stdout: string }
  | { readonly _tag: "Exit"; readonly exitCode: number; readonly stderr: string }

export const output = (stdout: string): FixedOutcome => ({ _tag: "Output", stdout })

export const exitWith = (exitCode: number, stderr: string): FixedOutcome => ({
  _tag: "Exit",
  exitCode,
  stderr,
})

function outcomeEffect(
  command: string,
  outcome: FixedOutcome,
): Effect.Effect<string, CommandFailed> {
  return outcome._tag === "Output"
    ? Effect.succeed(outcome.stdout)
    : Effect.fail(
        new CommandFailed({ command, exitCode: outcome.exitCode, stderr: outcome.stderr }),
      )
}

export interface CommandsFake {
  readonly layer: Layer.Layer<CommandRunner>
  /** Every command line run, in order. */
  readonly calls: readonly string[]
}

/** How a scripted command answers its `count`th run overall; `Option.none()` means it is missing. */
export type CommandScript = (
  command: string,
  args: readonly string[],
  count: number,
) => Option.Option<Effect.Effect<string, CommandFailed>>

/** Runs commands through `script`, recording every command line run. */
export function scriptedCommands(script: CommandScript): CommandsFake {
  const calls: string[] = []

  const layer = Layer.succeed(
    CommandRunner,
    CommandRunner.of({
      run: (command: string, args: readonly string[]) =>
        Effect.suspend((): Effect.Effect<string, CommandFailed | CommandMissing> => {
          calls.push([command, ...args].join(" "))

          return Option.match(script(command, args, calls.length), {
            onNone: () => Effect.fail(new CommandMissing({ command })),
            onSome: (answer: Effect.Effect<string, CommandFailed>) => answer,
          })
        }),
    }),
  )

  return { calls, layer }
}

/** Runs commands from a fixed table keyed by `command args`; anything else is missing. */
export const fixedCommands = (outcomes: Readonly<Record<string, FixedOutcome>>): CommandsFake =>
  scriptedCommands((command: string, args: readonly string[]) =>
    Option.map(
      Option.fromNullishOr(outcomes[[command, ...args].join(" ")]),
      (outcome: FixedOutcome) => outcomeEffect(command, outcome),
    ),
  )
