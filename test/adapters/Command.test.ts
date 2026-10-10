import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { Cause, Effect, Fiber, Option, Schedule } from "effect"
import { describe, expect, test } from "vitest"

import { CommandFailed, CommandMissing, CommandRunner, layer } from "../../src/adapters/Command.ts"

const run = async <A, E>(program: Effect.Effect<A, E, CommandRunner>): Promise<A> => {
  const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))

  return result
}

const directory = (): string => mkdtempSync(path.join(tmpdir(), "command-test-"))

function findMarker(folder: string, markers: readonly string[]): Option.Option<string> {
  return Option.fromNullishOr(markers.find((marker) => existsSync(path.join(folder, marker))))
}

const waitForMarkerEffect = (
  folder: string,
  markers: readonly string[],
): Effect.Effect<string, Cause.TimeoutError> =>
  Effect.sync(() => findMarker(folder, markers)).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("10 millis"),
      until: Option.isSome,
    }),
    Effect.flatMap((marker) =>
      Option.match(marker, {
        onNone: () => Effect.die("Marker polling stopped without finding a marker"),
        onSome: (value) => Effect.succeed(value),
      }),
    ),
    Effect.timeout("5 seconds"),
  )

const interruption = (
  folder: string,
): Effect.Effect<string, CommandMissing | CommandFailed | Cause.TimeoutError, CommandRunner> =>
  CommandRunner.use((runner) =>
    Effect.gen(function* () {
      // The busy builtin loop avoids a `sleep` child, whose foreground wait would defer traps.
      // The oracle depends on SIGTERM reaching the trap.
      const child = yield* Effect.forkChild(
        runner.run(
          "sh",
          [
            "-c",
            'trap \'touch "$1/interrupted"; exit 0\' TERM; : > "$1/started"; while [ ! -e "$1/release" ]; do :; done; : > "$1/finished"',
            "command-test",
            folder,
          ],
          folder,
        ),
      )

      const stop = Effect.fnUntraced(function* () {
        yield* Fiber.interrupt(child)
        yield* Effect.sync(() => {
          writeFileSync(path.join(folder, "release"), "")
        })

        return yield* waitForMarkerEffect(folder, ["interrupted", "finished"])
      })

      const exercise = Effect.gen(function* () {
        yield* waitForMarkerEffect(folder, ["started"])

        return yield* stop()
      })

      return yield* exercise.pipe(Effect.ensuring(stop().pipe(Effect.asVoid, Effect.orDie)))
    }),
  )

describe("CommandRunner", () => {
  test("returns standard output from the working directory", async () => {
    const cwd = directory()
    const output = await run(CommandRunner.use((runner) => runner.run("pwd", [], cwd)))

    expect(output.trim().endsWith(cwd.split("/").at(-1) ?? "")).toBe(true)
  })

  test("reports a non-zero exit with its code and standard error", async () => {
    const failure = await run(
      CommandRunner.use((runner) =>
        Effect.flip(runner.run("sh", ["-c", "echo oops >&2; exit 3"], directory())),
      ),
    )

    expect(failure).toMatchObject(
      new CommandFailed({ command: "sh", exitCode: 3, stderr: "oops\n" }),
    )
  })

  test("reports a missing executable", async () => {
    const failure = await run(
      CommandRunner.use((runner) =>
        Effect.flip(runner.run("definitely-not-a-command-xyz", [], directory())),
      ),
    )

    expect(failure).toMatchObject(new CommandMissing({ command: "definitely-not-a-command-xyz" }))
  })
})

describe("CommandRunner interruption", () => {
  test("kills the process when interrupted", async () => {
    const cwd = directory()
    const outcome = await run(interruption(cwd))

    expect(outcome).toBe("interrupted")
  })
})
