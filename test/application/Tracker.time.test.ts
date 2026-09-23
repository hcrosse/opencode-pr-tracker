import { describe, expect, test } from "bun:test"

import { Effect, Exit } from "effect"
import { TestClock } from "effect/testing"

import type { TrackerApi } from "../../src/application/Tracker.ts"
import { byUrl, ref, run, world } from "../support/tracker.ts"

// OpenCode's clock reports fractional milliseconds; stored times must stay whole.
describe("Tracker attachment time", () => {
  test("keeps an attachment made when the clock reports a fractional time", async () => {
    const result = await run(world(), (tracker: TrackerApi) =>
      TestClock.setTime(1_000.5).pipe(
        Effect.andThen(tracker.attach("session", byUrl(ref(1)), "/work")),
        Effect.andThen(tracker.list("session")),
        Effect.provide(TestClock.layer()),
      ),
    )

    expect(
      Exit.map(result, (tracking) => tracking.map((attachment) => attachment.attachedAt)),
    ).toEqual(Exit.succeed([1_000]))
  })
})
