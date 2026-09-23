import { describe, expect, test } from "bun:test"

import { Clock, Effect, Exit } from "effect"

import type { TrackerApi } from "../../src/application/Tracker.ts"
import { fixedClock } from "../support/application.ts"
import { byUrl, ref, run, world } from "../support/tracker.ts"

// OpenCode's clock reports fractional milliseconds; stored times must stay whole.
describe("Tracker attachment time", () => {
  test("keeps an attachment made when the clock reports a fractional time", async () => {
    const result = await run(world(), (tracker: TrackerApi) =>
      Effect.andThen(
        tracker.attach("session", byUrl(ref(1)), "/work"),
        tracker.list("session"),
      ).pipe(Effect.provideService(Clock.Clock, fixedClock(1_000.5))),
    )

    expect(
      Exit.map(result, (tracking) => tracking.map((attachment) => attachment.attachedAt)),
    ).toEqual(Exit.succeed([1_000]))
  })
})
