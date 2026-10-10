import { Effect, Exit, Layer } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"

import { layer as storageLayer } from "../../src/adapters/Storage.ts"
import { layer as monitorLayer, Monitor } from "../../src/application/Monitor.ts"
import { layer as trackerLayer, Tracker } from "../../src/application/Tracker.ts"
import { StoredStateInvalid } from "../../src/ports/TrackingRepository.ts"
import { memoryStorage, ScriptedGitHub, standalone } from "../support/application.ts"
import { captureLogs, type Logged } from "../support/logs.ts"
import {
  checking,
  open,
  refs,
  run,
  scriptAll,
  scripted,
  stackOf,
  watching,
  type App,
} from "../support/monitor.ts"

type Warning = Pick<Logged, "annotations" | "message">

const warningsIn = (lines: readonly Logged[]): Warning[] =>
  lines.flatMap((line: Logged) =>
    line.level === "WARN" ? [{ annotations: line.annotations, message: line.message }] : [],
  )

const skipped: Warning = {
  annotations: { sessionID: "b" },
  message: "Skipped polling a session with invalid stored state",
}

describe("Monitor polls with a session whose stored state is invalid", () => {
  test("warns once each time the session's stored state turns invalid", async () => {
    const storage = memoryStorage()
    const logs = captureLogs()

    const result = await run(
      scripted(),
      (app: App) =>
        Effect.gen(function* () {
          yield* watching(app, "a", [checking])
          yield* watching(app, "b", [open])

          const valid = storage.values.get("session/b") ?? null
          const polls = Effect.repeat(app.monitor.poll, { times: 2 })

          yield* storage.storage.set("session/b", { version: 99 })
          yield* polls
          yield* storage.storage.set("session/b", valid)
          yield* app.monitor.poll
          yield* storage.storage.set("session/b", { version: 99 })
          yield* polls
        }).pipe(Effect.provide(logs.layer)),
      storage,
    )

    expect(Exit.isSuccess(result)).toBe(true)
    expect(warningsIn(logs.lines())).toEqual([skipped, skipped])
  })
})

describe("Monitor forgets invalid sessions that are no longer watched", () => {
  test("warns again about a session watched again after its lease lapsed", async () => {
    const storage = memoryStorage()
    const logs = captureLogs()

    const result = await run(
      scripted(),
      (app: App) =>
        Effect.gen(function* () {
          yield* watching(app, "b", [open])
          yield* storage.storage.set("session/b", { version: 99 })
          yield* app.monitor.poll
          yield* TestClock.adjust("1 minute")
          yield* app.monitor.poll
          yield* app.monitor.watch("b")
          yield* app.monitor.poll
        }).pipe(Effect.provide(logs.layer)),
      storage,
    )

    expect(Exit.isSuccess(result)).toBe(true)
    expect(warningsIn(logs.lines())).toEqual([skipped, skipped])
  })
})

describe("Monitor forgets invalid sessions it is told to forget", () => {
  test("warns again about a session watched again right after it was forgotten", async () => {
    const storage = memoryStorage()
    const logs = captureLogs()

    const result = await run(
      scripted(),
      (app: App) =>
        Effect.gen(function* () {
          yield* watching(app, "b", [open])
          yield* storage.storage.set("session/b", { version: 99 })
          yield* app.monitor.poll
          yield* app.monitor.forget("b")
          yield* app.monitor.watch("b")
          yield* app.monitor.poll
        }).pipe(Effect.provide(logs.layer)),
      storage,
    )

    expect(Exit.isSuccess(result)).toBe(true)
    expect(warningsIn(logs.lines())).toEqual([skipped, skipped])
  })
})

/** Monitor and Tracker over `github`, except that regrouping always finds invalid stored state. */
const regroupFails = (github: Readonly<ScriptedGitHub>): Layer.Layer<Monitor | Tracker> => {
  const failing = Layer.effect(
    Tracker,
    Tracker.use((tracker) =>
      Effect.succeed(
        Tracker.of({
          attach: tracker.attach,
          detach: tracker.detach,
          forget: tracker.forget,
          list: tracker.list,
          regroup: (sessionID) => Effect.fail(new StoredStateInvalid({ sessionID })),
        }),
      ),
    ),
  )

  return monitorLayer.pipe(
    Layer.provideMerge(failing),
    Layer.provide(trackerLayer),
    Layer.provide([github.layer, storageLayer(memoryStorage().storage)]),
  )
}

describe("Monitor Stack regrouping that fails", () => {
  test("keeps the stored order with a warning", async () => {
    const github = new ScriptedGitHub()
    const logs = captureLogs()

    scriptAll(github, [1, 5, 8, 10], standalone)

    const program = Effect.gen(function* () {
      const app: App = { monitor: yield* Monitor, tracker: yield* Tracker }

      yield* watching(app, "a", refs([5, 1, 10, 8]))
      scriptAll(github, [5, 10], stackOf("s", [5, 10]))
      yield* TestClock.adjust("15 seconds")
      yield* app.monitor.poll.pipe(Effect.provide(logs.layer))

      return (yield* app.tracker.list("a")).map((attachment) => attachment.ref.number)
    })

    const result = await Effect.runPromise(
      Effect.exit(program.pipe(Effect.provide([regroupFails(github), TestClock.layer()]))),
    )

    expect(result).toEqual(Exit.succeed([5, 1, 10, 8]))
    expect(warningsIn(logs.lines())).toEqual([
      { annotations: { sessionID: "a" }, message: "Kept the order after a failed regroup" },
    ])
  })
})
