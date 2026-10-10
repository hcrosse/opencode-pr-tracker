import { describe, expect, test } from "bun:test"

import { Cause, Effect, Exit, Fiber, type Schema } from "effect"

import { memoryStorage, type StorageFake } from "../support/application.ts"
import { captureLogs, type Logged } from "../support/logs.ts"
import { open, run, scripted, watching, type App } from "../support/monitor.ts"

type Break = "unreadable" | "dies" | "dies while interrupted"

interface Breakable {
  readonly fake: StorageFake
  readonly breakWith: (how: Break) => void
}

/** Plugin storage in memory whose reads of session a can be broken partway through a test. */
function breakable(): Breakable {
  const memory = memoryStorage()
  let broken: Break | "no" = "no"

  const read = (key: string): Effect.Effect<Schema.Json | undefined> => {
    if (key !== "session/a" || broken === "no" || broken === "unreadable")
      return memory.storage.get(key)

    const defect = Cause.die("broken")

    return Effect.failCause(broken === "dies" ? defect : Cause.combine(defect, Cause.interrupt()))
  }

  const fake: StorageFake = {
    storage: {
      get: read,
      remove: (key) => memory.storage.remove(key),
      scan: (options) => memory.storage.scan(options),
      set: (key, value) => memory.storage.set(key, value),
    },
    values: memory.values,
    writes: () => memory.writes(),
  }

  const breakWith = (how: Break): void => {
    broken = how

    if (how === "unreadable") Effect.runSync(memory.storage.set("session/a", "unreadable"))
  }

  return { breakWith, fake }
}

interface Outcome {
  readonly exit: Exit.Exit<void, unknown>
  readonly lines: readonly (readonly unknown[])[]
}

/** Polls session a, breaking its stored state as `how` says after listing it and before publishing. */
async function pollBroken(how: Break): Promise<Outcome> {
  const github = scripted()
  const storage = breakable()
  const logs = captureLogs()

  const result = await run(
    github,
    (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [open])

        const held = yield* github.hold(open)
        const poll = yield* Effect.forkChild(app.monitor.poll)

        yield* held.started
        storage.breakWith(how)
        yield* held.release

        return yield* Fiber.await(poll)
      }).pipe(Effect.provide(logs.layer)),
    storage.fake,
  )

  if (Exit.isFailure(result)) throw new Error("publishing test setup failed")

  const lines = logs
    .lines()
    .map((line: Logged) => [line.level, line.message, line.annotations["sessionID"]])

  return { exit: result.value, lines }
}

const unpublished = "Session view was not published after a refresh"

describe("Monitor publishing failures", () => {
  test("logs a session whose view a poll could not read as a warning", async () => {
    const { exit, lines } = await pollBroken("unreadable")

    expect(exit).toEqual(Exit.void)
    expect(lines).toEqual([["WARN", unpublished, "a"]])
  })

  test("logs a defect while reading a session's view as an error", async () => {
    const { exit, lines } = await pollBroken("dies")

    expect(exit).toEqual(Exit.void)
    expect(lines).toEqual([["ERROR", unpublished, "a"]])
  })

  test("stops the poll without logging when reading the view is interrupted as it dies", async () => {
    const { exit, lines } = await pollBroken("dies while interrupted")

    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(lines).toEqual([])
  })
})
