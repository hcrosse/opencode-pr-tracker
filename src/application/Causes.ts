/** Recovering from failures without swallowing interruption. */
import { Cause, Effect } from "effect"

/** Only the interruptions in `cause`. */
export const interruptionsOf = <E>(cause: Cause.Cause<E>): Cause.Cause<never> =>
  Cause.fromReasons(cause.reasons.filter((reason) => Cause.isInterruptReason(reason)))

/**
 * Hands a failure or defect of `work` to `handle` and carries on. A cause that includes an
 * interruption ends `work` with just its interruptions: the fiber is stopping, so the rest is moot.
 */
export const continueAfter =
  (handle: (cause: Cause.Cause<unknown>) => Effect.Effect<void>) =>
  <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<void, never, R> =>
    Effect.catchCause(Effect.asVoid(work), (cause: Cause.Cause<E>) =>
      Cause.hasInterrupts(cause) ? Effect.failCause(interruptionsOf(cause)) : handle(cause),
    )

/** Logs a defect at error level and a failure at warning level. */
export const logBySeverity =
  (message: string) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Cause.hasDies(cause) ? Effect.logError(message, cause) : Effect.logWarning(message, cause)
