/** Carrying on past a session whose stored state is invalid, with a warning that says so. */
import { Array as Arr, Effect, Option } from "effect"

import type { Tracking } from "../domain/Tracking.ts"
import type { StoredStateInvalid } from "../ports/TrackingRepository.ts"

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
  private readonly list: (sessionID: string) => Effect.Effect<Tracking, StoredStateInvalid>

  /** `list` reads a session's attachments. */
  public constructor(list: (sessionID: string) => Effect.Effect<Tracking, StoredStateInvalid>) {
    this.list = list
  }

  /**
   * The attachments of each of `sessions` whose stored state is valid. A session left out of
   * `sessions` is forgotten, so it is warned about again if it is invalid when it next appears.
   */
  public validTrackings(sessions: readonly string[]): Effect.Effect<ReadonlyMap<string, Tracking>> {
    const forgotten = Effect.sync(() => {
      for (const sessionID of this.invalid)
        if (!sessions.includes(sessionID)) this.invalid.delete(sessionID)
    })

    const listed = Effect.forEach(sessions, (sessionID: string) =>
      this.list(sessionID).pipe(
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

  /** Forgets a session that is no longer watched, as a poll that no longer lists it would. */
  public end(sessionID: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.invalid.delete(sessionID)
    })
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
