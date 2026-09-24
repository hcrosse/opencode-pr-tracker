import { Effect, Option, Semaphore } from "effect"

interface SessionLock {
  readonly semaphore: Semaphore.Semaphore
  /** Operations queued or running on this lock. */
  readonly users: number
}

/**
 * Runs each session's operations one at a time. A session's lock is dropped once no operation
 * holds or awaits it; dropping it earlier would let a new operation create a second lock and
 * overlap operations still queued on the first.
 */
export class SessionLocks {
  private readonly locks = new Map<string, SessionLock>()

  /** How many sessions have operations queued or running. */
  public get held(): number {
    return this.locks.size
  }

  public run<A, E, R>(sessionID: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() =>
        restore(this.enter(sessionID).withPermit(effect)).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.leave(sessionID)
            }),
          ),
        ),
      ),
    )
  }

  private enter(sessionID: string): Semaphore.Semaphore {
    const { semaphore, users } = this.locks.get(sessionID) ?? {
      semaphore: Semaphore.makeUnsafe(1),
      users: 0,
    }

    this.locks.set(sessionID, { semaphore, users: users + 1 })

    return semaphore
  }

  private leave(sessionID: string): void {
    const current = Option.fromUndefinedOr(this.locks.get(sessionID))

    if (Option.isNone(current)) return

    const { semaphore, users } = current.value

    if (users === 1) this.locks.delete(sessionID)
    else this.locks.set(sessionID, { semaphore, users: users - 1 })
  }
}
