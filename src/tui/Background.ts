import { Effect, Fiber } from "effect"

/** Runs effects in the background, and stops those still running when the plugin unloads. */
export interface Background {
  readonly run: (effect: Effect.Effect<void>) => void
  readonly stop: () => void
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
    stop: () => {
      Effect.runFork(Fiber.interruptAll(running))
    },
  }
}
