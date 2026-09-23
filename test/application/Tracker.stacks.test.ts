import { describe, expect, test } from "bun:test"

import { Effect, Exit, Layer, Option } from "effect"

import { layer as storageLayer } from "../../src/adapters/Storage.ts"
import { layer as trackerLayer, Tracker } from "../../src/application/Tracker.ts"
import { memoryStorage, openState, reportOf, ScriptedGitHub } from "../support/application.ts"
import { ref } from "../support/monitor.ts"

describe("Tracker Stack discovery", () => {
  test("rejects a pull request whose Stack GitHub reported only in part, and stores nothing", async () => {
    const github = new ScriptedGitHub()
    const storage = memoryStorage()

    github.script(ref(1), { _tag: "Reported", report: reportOf(ref(1), openState, Option.none()) })

    const layer = trackerLayer.pipe(Layer.provide([github.layer, storageLayer(storage.storage)]))

    const result = await Effect.runPromise(
      Effect.exit(
        Tracker.use((tracker) =>
          tracker.attach("session", { _tag: "Reference", ref: ref(1) }, "/work"),
        ).pipe(Effect.provide(layer)),
      ),
    )

    expect(Exit.findErrorOption(result)).toMatchObject(Option.some({ _tag: "StackIncomplete" }))
    expect(storage.values.size).toBe(0)
  })
})
