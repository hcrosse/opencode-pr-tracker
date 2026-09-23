import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { Effect, Fiber } from "effect"

import { CommandRunner, layer } from "../../../src/adapters/github/Command.ts"

const run = async <A, E>(program: Effect.Effect<A, E, CommandRunner>): Promise<A> => {
  const result = await Effect.runPromise(program.pipe(Effect.provide(layer)))

  return result
}

const directory = (): string => mkdtempSync(path.join(tmpdir(), "command-test-"))

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

    expect(failure).toMatchObject({ _tag: "CommandFailed", exitCode: 3, stderr: "oops\n" })
  })

  test("reports a missing executable", async () => {
    const failure = await run(
      CommandRunner.use((runner) =>
        Effect.flip(runner.run("definitely-not-a-command-xyz", [], directory())),
      ),
    )

    expect(failure).toMatchObject({
      _tag: "CommandMissing",
      command: "definitely-not-a-command-xyz",
    })
  })
})

describe("CommandRunner interruption", () => {
  test("kills the process when interrupted", async () => {
    const cwd = directory()
    const marker = path.join(cwd, "finished")

    await run(
      CommandRunner.use((runner) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(
            runner.run("sh", ["-c", `sleep 1; touch ${marker}`], cwd),
          )

          yield* Effect.sleep("100 millis")
          yield* Fiber.interrupt(fiber)
        }),
      ),
    )
    await Bun.sleep(1500)

    expect(existsSync(marker)).toBe(false)
  })
})
