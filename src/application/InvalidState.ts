/** Carrying on past a session whose stored state is invalid, with a warning that says so. */
import { Array as Arr, Effect, Option } from "effect"

import type { Tracking } from "../domain/Tracking.ts"
import type { StoredStateInvalid } from "../ports/TrackingRepository.ts"
import type { TrackerApi } from "./Tracker.ts"

const warn = (message: string, sessionID: string): Effect.Effect<void> =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ sessionID }))

/** `effect`, or `fallback` with a warning `message` if the session's stored state is invalid. */
export const orWarned = <A, B>(
  effect: Effect.Effect<A, StoredStateInvalid>,
  message: string,
  fallback: B,
): Effect.Effect<A | B> =>
  Effect.catchTag(effect, "StoredStateInvalid", (failure) =>
    Effect.as(warn(message, failure.sessionID), fallback),
  )

type Listed = Option.Option<readonly [string, Tracking]>

/** Sessions whose stored state was invalid when last listed, so each is warned about once. */
export class InvalidSessions {
  private readonly invalid = new Set<string>()

  /**
   * The attachments of each of `sessions` whose stored state is valid. A session left out of
   * `sessions` is forgotten, so it is warned about again if it is invalid when it next appears.
   */
  public validTrackings(
    tracker: TrackerApi,
    sessions: readonly string[],
  ): Effect.Effect<ReadonlyMap<string, Tracking>> {
    const forgotten = Effect.sync(() => {
      for (const sessionID of this.invalid)
        if (!sessions.includes(sessionID)) this.invalid.delete(sessionID)
    })

    const listed = Effect.forEach(sessions, (sessionID: string) =>
      tracker.list(sessionID).pipe(
        Effect.map((tracking): Listed => {
          this.invalid.delete(sessionID)

          return Option.some([sessionID, tracking])
        }),
        Effect.catchTag("StoredStateInvalid", () => this.skipped(sessionID)),
      ),
    )

    return Effect.andThen(forgotten, listed).pipe(
      Effect.map((entries: readonly Listed[]) => new Map(Arr.getSomes(entries))),
    )
  }

  private skipped(sessionID: string): Effect.Effect<Listed> {
    return Effect.suspend(() => {
      const known = this.invalid.has(sessionID)

      this.invalid.add(sessionID)

      return Effect.as(
        known
          ? Effect.void
          : warn("Skipped polling a session with invalid stored state", sessionID),
        Option.none(),
      )
    })
  }
}
