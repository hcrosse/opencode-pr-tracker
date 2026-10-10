import { Cause, type Duration, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"

import { pollRepeatedly } from "../../src/server/Background.ts"
import { captureLogs, type Logged } from "../support/logs.ts"

interface Outcome {
  readonly exit: Exit.Exit<void, unknown>
  readonly passes: number
  readonly lines: readonly (readonly unknown[])[]
}

/** Polls every second for `seconds` of test time, where pass `n` (from 1) is `pass(n)`, then interrupts. */
async function polling(
  seconds: Duration.Input,
  pass: (n: number) => Effect.Effect<void, string>,
): Promise<Outcome> {
  const logs = captureLogs()
  let passes = 0

  const poll = Effect.suspend(() => {
    passes += 1

    return pass(passes)
  })

  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(pollRepeatedly(poll, "1 second"))

      yield* Effect.yieldNow
      yield* TestClock.adjust(seconds)
      yield* Fiber.interrupt(fiber)

      return yield* Fiber.await(fiber)
    }).pipe(Effect.provide([logs.layer, TestClock.layer()])),
  )

  const lines = logs
    .lines()
    .map((line: Logged) => [line.level, line.message, line.annotations["failedPasses"] ?? null])

  return { exit, lines, passes }
}

describe("polling", () => {
  test("logs the first of a run of failed passes, keeps polling, and logs the recovery", async () => {
    const { exit, lines, passes } = await polling("5 seconds", (n) =>
      n >= 2 && n <= 4 ? Effect.die("broken") : Effect.void,
    )

    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(passes).toBe(6)
    expect(lines).toEqual([
      ["ERROR", "Poll failed; repeated failures are not logged until a pass succeeds", null],
      ["INFO", "Polling recovered", 3],
    ])
  })

  test("stops without logging when a pass is interrupted as it fails", async () => {
    const { exit, lines, passes } = await polling("5 seconds", (n) =>
      n === 2
        ? Effect.failCause(Cause.combine(Cause.fail("broken"), Cause.interrupt()))
        : Effect.void,
    )

    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(passes).toBe(2)
    expect(lines).toEqual([])
  })
})
