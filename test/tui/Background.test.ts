import { describe, expect, test } from "bun:test"

import { Effect, Latch } from "effect"

import { background } from "../../src/tui/Background.ts"

interface Task {
  readonly effect: Effect.Effect<void>
  /** Opens once the effect has been interrupted. */
  readonly stopped: Latch.Latch
}

/** An effect that runs until it is interrupted. */
function untilInterrupted(): Task {
  const stopped = Latch.makeUnsafe()

  return {
    effect: Effect.onInterrupt(Effect.never, () => stopped.open),
    stopped,
  }
}

describe("background effects", () => {
  test("interrupting one effect leaves the others running", async () => {
    const tasks = background()
    const first = untilInterrupted()
    const second = untilInterrupted()

    const interruptFirst = tasks.run(first.effect)

    tasks.run(second.effect)
    interruptFirst()
    await Effect.runPromise(first.stopped.await)

    expect(second.stopped.isOpen()).toBe(false)

    await tasks.stop()

    expect(second.stopped.isOpen()).toBe(true)
  })

  test("stop interrupts every running effect", async () => {
    const tasks = background()
    const all = [untilInterrupted(), untilInterrupted()]

    for (const task of all) tasks.run(task.effect)
    await tasks.stop()

    expect(all.map((task) => task.stopped.isOpen())).toEqual([true, true])
  })
})
