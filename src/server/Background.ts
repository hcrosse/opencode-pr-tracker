/** Work the server keeps running for as long as the plugin is loaded. */
import type { Plugin } from "@opencode/plugin/effect"
import { Cause, Duration, Effect, Ref, Result, Schedule, Schema, Stream } from "effect"

import { continueAfter, interruptionsOf, logBySeverity } from "../application/Causes.ts"
import type { Services } from "./Requests.ts"

type OpenCodeEvent = Stream.Success<ReturnType<Plugin.Context["event"]["subscribe"]>>

interface SessionDeleted {
  readonly type: "session.deleted"
  readonly data: { readonly sessionID: string }
}

interface OtherEvent {
  readonly type: Exclude<OpenCodeEvent["type"], "session.deleted">
}

/** The part of an OpenCode event that session cleanup reads. */
export type CleanupEvent = SessionDeleted | OtherEvent

/** OpenCode's event stream completed, which it should never do while the plugin is loaded. */
export class EventsEnded extends Schema.TaggedError<EventsEnded>()("EventsEnded", {}) {}

/**
 * Backs off from 1 second, doubling, for up to nine consecutive retries, so the tenth failure in a
 * row stops cleanup. Any event resets the count.
 */
const resubscriptions = Schedule.exponential("1 second").pipe(
  Schedule.upTo({ times: 9 }),
  Schedule.setInputType<unknown>(),
  Schedule.tap(({ attempt, duration, input }) =>
    Effect.logWarning(
      "Session deletion events failed; subscribing again. Sessions deleted meanwhile are not forgotten",
      Cause.fail(input),
    ).pipe(Effect.annotateLogs({ attempt, delayMs: Duration.toMillis(duration) })),
  ),
)

/** Logs why a background task stopped, unless it was interrupted, and keeps the failure. */
const logStop =
  (message: string) =>
  <A, E, R>(task: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.tapCauseIf(
      task,
      (cause: Cause.Cause<E>) => !Cause.hasInterrupts(cause),
      (cause: Cause.Cause<E>) => Effect.logError(message, cause),
    )

/** Logs a failure or defect that is not an interruption at error level, and carries on. */
const logAndContinue = (
  message: string,
): (<A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<void, never, R>) =>
  continueAfter((cause: Cause.Cause<unknown>) => Effect.logError(message, cause))

/**
 * Forgets each session OpenCode deletes, everywhere. Forgetting one session failing is logged and
 * does not stop the others. When the events fail or end they are subscribed again with backoff;
 * once that gives up, or the events die, the task logs an error and stops.
 */
export const forgetDeletedSessions = Effect.fn("Background.forgetDeletedSessions")(function* (
  events: Stream.Stream<CleanupEvent, unknown>,
  services: Services,
) {
  yield* events.pipe(
    Stream.concat(Stream.fail(new EventsEnded())),
    // Stream.retry would retry a failure that came with an interruption, and drop the interruption.
    Stream.catchCauseIf(
      (cause: Cause.Cause<unknown>) => Cause.hasInterrupts(cause),
      (cause: Cause.Cause<unknown>) => Stream.failCause(interruptionsOf(cause)),
    ),
    Stream.retry(resubscriptions),
    Stream.filterMap((event: CleanupEvent) =>
      event.type === "session.deleted" ? Result.succeed(event.data.sessionID) : Result.failVoid,
    ),
    Stream.runForEach((sessionID: string) =>
      Effect.all(
        [services.tracker.forget(sessionID), services.monitor.forget(sessionID)].map((forget) =>
          forget.pipe(logAndContinue("Session was not forgotten after deletion")),
        ),
        { discard: true },
      ).pipe(Effect.annotateLogs({ sessionID })),
    ),
    logStop("Session deletion cleanup stopped; deleted sessions are no longer forgotten"),
  )
})

/** Something sent to the sidebar about one session. */
interface SessionUpdate {
  readonly sessionID: string
}

/**
 * Encodes each view in `changes` and sends it. A view that cannot be encoded is logged as an error
 * and skipped; one that cannot be sent is logged, as a warning or for a defect as an error, and
 * later views still go out. A defect in `changes` itself stops the task with an error log.
 */
export const sendUpdates = Effect.fn("Background.sendUpdates")(function* <
  V extends SessionUpdate,
  D,
  E,
>(
  changes: Stream.Stream<V>,
  encode: (view: V) => Effect.Effect<D, E>,
  send: (data: D) => Effect.Effect<void, unknown>,
) {
  yield* Stream.runForEach(changes, (view: V) =>
    encode(view).pipe(
      Effect.flatMap((data: D) =>
        send(data).pipe(continueAfter(logBySeverity("Pull request update was not sent"))),
      ),
      continueAfter((cause: Cause.Cause<unknown>) =>
        Effect.logError("A session view could not be encoded, so it was not published", cause),
      ),
      Effect.annotateLogs({ sessionID: view.sessionID }),
    ),
  ).pipe(logStop("Pull request updates stopped; the sidebar no longer refreshes"))
})

/**
 * Runs `poll` every `interval`. A pass that fails or dies does not stop polling: the first failure
 * in a row is logged as an error, repeats are not, and the next pass that succeeds logs how many
 * failed. Only interruption stops it.
 */
export const pollRepeatedly = Effect.fn("Background.pollRepeatedly")(function* <E>(
  poll: Effect.Effect<void, E>,
  interval: Duration.Input,
) {
  const failedPasses = yield* Ref.make(0)

  const recovered = Effect.flatMap(Ref.getAndSet(failedPasses, 0), (failed: number) =>
    failed === 0
      ? Effect.void
      : Effect.logInfo("Polling recovered").pipe(Effect.annotateLogs({ failedPasses: failed })),
  )

  const failed = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Effect.flatMap(
      Ref.getAndUpdate(failedPasses, (count: number) => count + 1),
      (before: number) =>
        before === 0
          ? Effect.logError(
              "Poll failed; repeated failures are not logged until a pass succeeds",
              cause,
            )
          : Effect.void,
    )

  yield* poll.pipe(
    Effect.andThen(recovered),
    continueAfter(failed),
    // Effect.repeat drops the interruption from a cause that also has a failure (effect 4.0.0-rc.112).
    Effect.andThen(Effect.sleep(interval)),
    Effect.forever,
  )
})
