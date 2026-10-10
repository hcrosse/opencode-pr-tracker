/** Keeps a shown session's lease renewed, and notices when it would have lapsed. */
import { Clock, Duration, Effect, Schedule } from "effect"
import { constVoid } from "effect/Function"
import { onCleanup } from "solid-js"

import { leaseDuration } from "../domain/Lease.ts"
import type { Interrupt, Run } from "./Background.ts"
import { RequestFailed } from "./Client.ts"

/** How often a shown session's lease is renewed, well within the server's lease. */
const renewalInterval = 15_000

/**
 * How long a request that renews the lease may take, so a hung call cannot hold back the ones
 * after it, and an answer arrives well inside the lease it renewed unless the computer slept.
 */
const requestTimeout = 5000

const unanswered = new RequestFailed({
  message: "The pull request tracker did not answer in time.",
})

const inTime = <A>(request: Effect.Effect<A, RequestFailed>): Effect.Effect<A, RequestFailed> =>
  Effect.timeoutOrElse(request, { duration: requestTimeout, orElse: () => Effect.fail(unanswered) })

/** A request's answer, and whether the lease holds now that the request has renewed it. */
export interface Renewed<A> {
  readonly answer: A
  readonly holds: boolean
}

/** The server's lease on the shown session, as far as the sidebar can tell. */
export interface Lease {
  /**
   * Runs `request`, which renews the lease when it succeeds, as watching or listing the session
   * does, and fails it after 5 seconds without an answer. A success extends the lease from when
   * the request was sent, so it never outlasts the server's.
   */
  readonly renewing: <A>(
    request: Effect.Effect<A, RequestFailed>,
  ) => Effect.Effect<Renewed<A>, RequestFailed>
}

/**
 * A lease that starts now and calls `onLapse` once it would have lapsed without a renewal, and
 * again after each later lapse. Ends when the owning reactive scope is cleaned up.
 */
export function leaseUntilLapse(run: Run, onLapse: () => void): Lease {
  let deadline = Number.NEGATIVE_INFINITY
  let ended = false
  let stop: Interrupt = constVoid

  const lapseIfDue = Effect.map(Clock.currentTimeMillis, (now) => {
    if (!ended && now >= deadline) onLapse()
  })

  // Renewals can answer out of order, so a lease only ever moves later.
  const extendFrom = (sentAt: number): Effect.Effect<boolean> =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const until = sentAt + Duration.toMillis(leaseDuration)

      if (!ended && until > deadline) {
        deadline = until
        stop()
        stop = run(Effect.andThen(Effect.sleep(Math.max(0, until - now)), lapseIfDue))
      }

      return now < deadline
    })

  run(Effect.asVoid(Effect.flatMap(Clock.currentTimeMillis, extendFrom)))
  onCleanup(() => {
    ended = true
    stop()
  })

  return {
    renewing: (request) =>
      Effect.flatMap(Clock.currentTimeMillis, (sentAt) =>
        Effect.flatMap(inTime(request), (answer) =>
          Effect.map(extendFrom(sentAt), (holds): Renewed<typeof answer> => ({ answer, holds })),
        ),
      ),
  }
}

/**
 * Runs `renewal` every 15 seconds until the owning reactive scope is cleaned up, calling
 * `onRenewed` after each one that succeeds.
 */
export function renewWhileShown(
  renewal: Effect.Effect<Renewed<void>, RequestFailed>,
  run: Run,
  onRenewed: () => void,
): void {
  // Each renewal starts on a 15-second boundary, never overlaps the previous one and ends within
  // 5 seconds, so successful renewals land at most 20 seconds apart, or 35 after one failed
  // renewal, inside the 45-second lease. Failures, and a defect that ends this loop, show only
  // through the lease's lapse, which runs apart from the loop: the plugin API has no log sink.
  const renewOnce = Effect.ignore(Effect.andThen(renewal, Effect.sync(onRenewed)))

  onCleanup(run(Effect.asVoid(Effect.schedule(renewOnce, Schedule.fixed(renewalInterval)))))
}
