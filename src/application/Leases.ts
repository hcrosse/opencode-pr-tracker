import { Duration, Effect } from "effect"

import { leaseDuration } from "../domain/Lease.ts"
import { currentMillis } from "./Time.ts"

/** The sessions someone is watching. Each session's lease lapses unless it is renewed in time. */
export class Leases {
  /** When each session's lease was last renewed, in epoch milliseconds. */
  private readonly renewedAt = new Map<string, number>()

  public renew(sessionID: string): Effect.Effect<void> {
    return Effect.map(currentMillis, (now) => {
      this.renewedAt.set(sessionID, now)
    })
  }

  public end(sessionID: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.renewedAt.delete(sessionID)
    })
  }

  /** The sessions whose lease has not lapsed. Lapsed leases are dropped. */
  public live(): Effect.Effect<string[]> {
    return Effect.map(currentMillis, (now) => {
      for (const [sessionID, renewedAt] of this.renewedAt)
        if (now - renewedAt >= Duration.toMillis(leaseDuration)) this.renewedAt.delete(sessionID)

      return [...this.renewedAt.keys()]
    })
  }
}
