import { Effect, Fiber } from "effect"

/** Runs effects in the background, and stops those still running when the plugin unloads. */
export interface Background {
  readonly run: (effect: Effect.Effect<void>) => void
  /** Interrupts the running effects and resolves once they have stopped. */
  readonly stop: () => Promise<void>
}

export function background(): Background {
  const running = new Set<Fiber.Fiber<void>>()

  return {
    run: (effect) => {
      const fiber = Effect.runFork(effect)

      running.add(fiber)
      fiber.addObserver(() => {
        running.delete(fiber)
      })
    },
    stop: async () => {
      await Effect.runPromise(Fiber.interruptAll(running))
    },
  }
}
