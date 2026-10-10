import { Effect, Fiber } from "effect"

/** Stops one background effect without waiting for it to finish stopping. */
export type Interrupt = () => void

/** Starts an effect in the background, returning how to stop it. */
export type Run = (effect: Effect.Effect<void>) => Interrupt

/** Runs effects in the background, and stops those still running when the plugin unloads. */
export interface Background {
  readonly run: Run
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

      return () => {
        Effect.runFork(Fiber.interrupt(fiber))
      }
    },
    stop: async () => {
      await Effect.runPromise(Fiber.interruptAll(running))
    },
  }
}
