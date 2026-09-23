import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { type Clock, Deferred, Effect, Layer, Option, Result, type Schema } from "effect"

import { parsePullRequestUrl, type PullRequestRef } from "../../src/domain/PullRequest.ts"
import type { Diagnostic, PullRequestState } from "../../src/domain/Snapshot.ts"
import type { Membership } from "../../src/domain/StackLayout.ts"
import {
  GitHub,
  GitHubFailure,
  RepositoryUnavailable,
  type ItemResult,
  type Report,
} from "../../src/ports/GitHub.ts"

export interface StorageFake {
  readonly storage: StorageDomain
  /** The stored values, by key. */
  readonly values: ReadonlyMap<string, Schema.Json>
}

/**
 * Plugin storage kept in a map, as `ctx.storage` behaves for one plugin ID. Like the real storage,
 * every operation is asynchronous, so other fibers can run between a read and a write.
 */
export function memoryStorage(): StorageFake {
  const values = new Map<string, Schema.Json>()

  const storage: StorageDomain = {
    get: (key: string) =>
      Effect.andThen(
        Effect.yieldNow,
        Effect.sync(() => values.get(key)),
      ),
    remove: (key: string) =>
      Effect.sync(() => {
        values.delete(key)
      }),
    scan: ({ prefix }) =>
      Effect.sync(() => ({
        entries: [...values].flatMap(([key, value]: readonly [string, Schema.Json]) =>
          key.startsWith(prefix) ? [{ key, value }] : [],
        ),
      })),
    set: (key: string, value: Schema.Json) =>
      Effect.andThen(
        Effect.yieldNow,
        Effect.sync(() => {
          values.set(key, value)
        }),
      ),
  }

  return { storage, values }
}

/** A clock stopped at `millis`, which may be fractional. */
export function fixedClock(millis: number): Clock.Clock {
  const nanos = BigInt(Math.round(millis * 1_000_000))

  return {
    currentTimeMillis: Effect.succeed(millis),
    currentTimeMillisUnsafe: () => millis,
    currentTimeNanos: Effect.succeed(nanos),
    currentTimeNanosUnsafe: () => nanos,
    monotonicTimeNanos: Effect.succeed(nanos),
    monotonicTimeNanosUnsafe: () => nanos,
    sleep: () => Effect.void,
  }
}

export const standalone: Membership = { _tag: "Standalone" }

/** What GitHub reports for a pull request, with `membership` unknown unless given. */
export const reportOf = (
  ref: PullRequestRef,
  state: PullRequestState,
  membership: Option.Option<Membership> = Option.none(),
): Report => ({ membership, snapshot: { ref, state, title: `Title of ${ref.label}` } })

export const reported = (
  ref: PullRequestRef,
  state: PullRequestState,
  membership: Membership,
): ItemResult => ({ _tag: "Reported", report: reportOf(ref, state, Option.some(membership)) })

export const openState: PullRequestState = {
  _tag: "Open",
  behind: false,
  ci: "passed",
  draft: false,
  mergeability: "mergeable",
}

interface Hold {
  readonly gate: Deferred.Deferred<boolean>
  readonly started: Deferred.Deferred<boolean>
}

export interface Held {
  /** Completes once a held fetch has begun. */
  readonly started: Effect.Effect<boolean>
  /** Lets held fetches finish. */
  readonly release: Effect.Effect<boolean>
}

/** How tests control and observe the scripted GitHub. */
export interface GitHubScript {
  readonly layer: Layer.Layer<GitHub>
  /** The URLs of every fetch, in order. */
  readonly fetches: readonly (readonly string[])[]
  readonly script: (ref: PullRequestRef, result: ItemResult) => void
  readonly failRequests: (diagnostic: Option.Option<Diagnostic>) => void
  readonly checkout: (directory: string, repositoryUrl: string) => void
  readonly hold: (ref: PullRequestRef) => Effect.Effect<Held>
}

/** A GitHub whose answers each test sets, recording every fetch. Unscripted pull requests are not found. */
export class ScriptedGitHub implements GitHubScript {
  private readonly recorded: (readonly string[])[] = []
  private readonly results = new Map<string, ItemResult>()
  private readonly held = new Map<string, Hold>()
  private readonly repositories = new Map<string, string>()
  private failing = Option.none<Diagnostic>()

  public get fetches(): readonly (readonly string[])[] {
    return this.recorded
  }

  public get layer(): Layer.Layer<GitHub> {
    return Layer.succeed(
      GitHub,
      GitHub.of({
        fetch: (refs: readonly PullRequestRef[]) => Effect.suspend(() => this.fetch(refs)),
        pullRequestInRepository: (directory: string, number: number) =>
          this.resolve(directory, number),
      }),
    )
  }

  /** Sets what GitHub reports for a pull request from now on. */
  public script(ref: PullRequestRef, result: ItemResult): void {
    this.results.set(ref.url, result)
  }

  /** Makes every fetch fail as a whole with `diagnostic`, or stops failing with none. */
  public failRequests(diagnostic: Option.Option<Diagnostic>): void {
    this.failing = diagnostic
  }

  /** Sets the repository `gh repo view` finds in `directory`. */
  public checkout(directory: string, repositoryUrl: string): void {
    this.repositories.set(directory, repositoryUrl)
  }

  /** Holds fetches that include `ref`: `started` completes when one begins, `release` lets it finish. */
  public hold(ref: PullRequestRef): Effect.Effect<Held> {
    const { held } = this

    return Effect.gen(function* () {
      const hold: Hold = {
        gate: yield* Deferred.make<boolean>(),
        started: yield* Deferred.make<boolean>(),
      }

      held.set(ref.url, hold)

      return { release: Deferred.succeed(hold.gate, true), started: Deferred.await(hold.started) }
    })
  }

  private fetch(
    refs: readonly PullRequestRef[],
  ): Effect.Effect<ReadonlyMap<string, ItemResult>, GitHubFailure> {
    const holds = refs.flatMap((ref) =>
      Option.toArray(Option.fromNullishOr(this.held.get(ref.url))),
    )

    const missing: ItemResult = { _tag: "Failed", diagnostic: "NotFound" }

    const waitForRelease = Effect.forEach(
      holds,
      (hold: Hold) =>
        Effect.andThen(Deferred.succeed(hold.started, true), Deferred.await(hold.gate)),
      { discard: true },
    )

    this.recorded.push(refs.map((ref) => ref.url))

    // A real request is asynchronous; yielding lets other fibers run meanwhile, as they would.
    return Effect.andThen(
      Effect.andThen(Effect.yieldNow, waitForRelease),
      Option.match(this.failing, {
        onNone: () =>
          Effect.succeed(
            new Map(refs.map((ref) => [ref.url, this.results.get(ref.url) ?? missing] as const)),
          ),
        onSome: (diagnostic: Diagnostic) => Effect.fail(new GitHubFailure({ diagnostic })),
      }),
    )
  }

  private resolve(
    directory: string,
    number: number,
  ): Effect.Effect<PullRequestRef, RepositoryUnavailable> {
    return Option.match(Option.fromNullishOr(this.repositories.get(directory)), {
      onNone: () => Effect.fail(new RepositoryUnavailable({ directory })),
      onSome: (repository: string) =>
        Effect.sync(() =>
          Result.getOrThrow(parsePullRequestUrl(`${repository}/pull/${String(number)}`)),
        ),
    })
  }
}
