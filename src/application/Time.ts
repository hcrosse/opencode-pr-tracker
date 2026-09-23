import { Clock, Effect } from "effect"

/**
 * The current time in whole epoch milliseconds. `Clock` promises only a number, and OpenCode's
 * clock reports fractions, but attachment and failure times are stored as integers.
 */
export const currentMillis: Effect.Effect<number> = Effect.map(Clock.currentTimeMillis, Math.floor)
