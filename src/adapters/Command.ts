import { Context, Effect, Layer, Schema, type Scope } from "effect"

export class CommandMissing extends Schema.TaggedError<CommandMissing>()("CommandMissing", {
  command: Schema.String,
}) {}

export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  exitCode: Schema.Int,
  stderr: Schema.String,
}) {}

export interface CommandRunnerApi {
  /** Runs `command` to completion and returns its standard output. Interruption kills it. */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => Effect.Effect<string, CommandMissing | CommandFailed>
}

export class CommandRunner extends Context.Service<CommandRunner, CommandRunnerApi>()(
  "opencode-pr-tracker/CommandRunner",
) {}

/** The parts of a running process this adapter uses. */
interface Child {
  readonly running: () => boolean
  readonly kill: () => void
  readonly completed: () => Promise<readonly [stdout: string, stderr: string, exitCode: number]>
}

const isMissingExecutable = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))

function spawn(command: string, args: readonly string[], cwd: string): Child {
  const process = Bun.spawn([command, ...args], {
    cwd,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  })

  return {
    completed: async () => {
      const result = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ])

      return result
    },
    kill: () => {
      process.kill()
    },
    running: () => process.exitCode === null,
  }
}

/** Starts the process; closing the scope, including on interruption, kills it if still running. */
function start(
  command: string,
  args: readonly string[],
  cwd: string,
): Effect.Effect<Child, CommandMissing | CommandFailed, Scope.Scope> {
  const started = Effect.try({
    catch: (cause) =>
      isMissingExecutable(cause)
        ? new CommandMissing({ command })
        : new CommandFailed({ command, exitCode: -1, stderr: String(cause) }),
    try: () => spawn(command, args, cwd),
  })

  return Effect.acquireRelease(started, (child: Child) =>
    Effect.sync(() => {
      if (child.running()) child.kill()
    }),
  )
}

function output(command: string, child: Child): Effect.Effect<string, CommandFailed> {
  return Effect.gen(function* () {
    const [stdout, stderr, exitCode] = yield* Effect.promise(child.completed)

    if (exitCode === 0) return stdout

    return yield* new CommandFailed({ command, exitCode, stderr })
  })
}

export const layer = Layer.succeed(
  CommandRunner,
  CommandRunner.of({
    run: (command, args, cwd) =>
      Effect.scoped(
        Effect.flatMap(start(command, args, cwd), (child: Child) => output(command, child)),
      ),
  }),
)
