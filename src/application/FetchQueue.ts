import { type Cause, Deferred, Effect, Exit, Option, type Scope } from "effect"

import type { PullRequestRef } from "../domain/PullRequest.ts"

/** The fetch after the running one, shared by every request made while that one runs. */
interface Queued {
  readonly refs: Map<string, PullRequestRef>
  readonly done: Deferred.Deferred<boolean>
}

/**
 * Runs a fetch one call at a time. Requests made while a fetch runs join a single following fetch
 * of all their pull requests, so a burst of requests costs at most two fetches. Each request
 * completes once a fetch that started after it has finished. Fetches run in the given scope, so an
 * interrupted caller does not cancel a fetch that others are waiting for. A fetch that dies fails
 * the requests waiting for it; the next request starts a new fetch.
 */
export class FetchQueue {
  private running = false
  private queued = Option.none<Queued>()
  private readonly fetchNow: (refs: readonly PullRequestRef[]) => Effect.Effect<void>
  private readonly scope: Scope.Scope

  public constructor(
    fetchNow: (refs: readonly PullRequestRef[]) => Effect.Effect<void>,
    scope: Scope.Scope,
  ) {
    this.fetchNow = fetchNow
    this.scope = scope
  }

  public fetch(refs: readonly PullRequestRef[]): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (refs.length === 0) return Effect.void

      if (this.running) return Effect.asVoid(Deferred.await(this.join(refs)))

      this.running = true

      const done = Deferred.makeUnsafe<boolean>()

      return Effect.andThen(Effect.forkIn(this.drain(refs, done), this.scope), Deferred.await(done))
    })
  }

  private join(refs: readonly PullRequestRef[]): Deferred.Deferred<boolean> {
    const next = Option.getOrElse(this.queued, (): Queued => ({
      done: Deferred.makeUnsafe(),
      refs: new Map(),
    }))

    for (const ref of refs) next.refs.set(ref.url, ref)
    this.queued = Option.some(next)

    return next.done
  }

  private drain(
    refs: readonly PullRequestRef[],
    done: Deferred.Deferred<boolean>,
  ): Effect.Effect<void> {
    return this.fetchNow(refs).pipe(
      Effect.andThen(Deferred.succeed(done, true)),
      Effect.andThen(Effect.suspend(() => this.next())),
      // A fetch that dies, or is interrupted when the scope closes, fails its waiters and resets the queue.
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Effect.suspend(() => this.reset(done, exit.cause)),
      ),
    )
  }

  private next(): Effect.Effect<void> {
    return Option.match(this.queued, {
      onNone: () =>
        Effect.sync(() => {
          this.running = false
        }),
      onSome: (queued) => {
        this.queued = Option.none()

        return this.drain([...queued.refs.values()], queued.done)
      },
    })
  }

  private reset(done: Deferred.Deferred<boolean>, cause: Cause.Cause<never>): Effect.Effect<void> {
    const waiting = [done, ...Option.toArray(Option.map(this.queued, (queued) => queued.done))]

    this.running = false
    this.queued = Option.none()

    return Effect.forEach(waiting, (deferred) => Deferred.failCause(deferred, cause), {
      discard: true,
    })
  }
}
