/** GitHub rate limits: recognizing a limited response, and a wait every plugin instance honors. */
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Clock, Context, Duration, Effect, Layer, Option, Schema } from "effect"

import { GitHubFailure } from "../../ports/GitHub.ts"

/** What a response says about rate limiting. Header names are lowercase. */
export interface Evidence {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: string
  readonly errorTypes: readonly string[]
}

export type Verdict =
  | { readonly _tag: "Allowed" }
  /** `until` is the epoch millisecond GitHub said to wait until, if it said. */
  | { readonly _tag: "Limited"; readonly until: Option.Option<number> }

const longestHint = Duration.toMillis(Duration.hours(1))

/** A header of whole seconds. Anything else, such as an HTTP date, is unusable. */
const secondsHeader = (evidence: Evidence, name: string): Option.Option<number> =>
  Option.map(
    Option.filter(Option.fromNullishOr(evidence.headers[name]), (value: string) =>
      /^\d+$/u.test(value),
    ),
    Number,
  )

const spent = (evidence: Evidence): boolean => evidence.headers["x-ratelimit-remaining"] === "0"

/**
 * `retry-after` in seconds, or the reset time once the remaining budget is spent, at most an hour
 * away. A reset time already past lets the next request through.
 */
function hintedUntil(evidence: Evidence, now: number): Option.Option<number> {
  const retryAfter = Option.map(
    secondsHeader(evidence, "retry-after"),
    (seconds: number) => now + seconds * 1000,
  )

  const reset = spent(evidence)
    ? Option.map(secondsHeader(evidence, "x-ratelimit-reset"), (seconds: number) => seconds * 1000)
    : Option.none()

  return Option.map(
    Option.orElse(retryAfter, () => reset),
    (at: number) => Math.min(at, now + longestHint),
  )
}

/**
 * Primary limits answer 403 or 429 with headers, or GraphQL `RATE_LIMITED`. A secondary limit may
 * say so only in its body.
 */
export function verdictOf(evidence: Evidence, now: number): Verdict {
  const limited =
    evidence.status === 429 ||
    evidence.errorTypes.includes("RATE_LIMITED") ||
    (evidence.status === 403 &&
      (Option.isSome(Option.fromNullishOr(evidence.headers["retry-after"])) ||
        spent(evidence) ||
        /rate limit/iu.test(evidence.body)))

  return limited ? { _tag: "Limited", until: hintedUntil(evidence, now) } : { _tag: "Allowed" }
}

/** Epoch milliseconds before which no request is sent. */
const untilKey = "github/rate-limit/until"

/** Consecutive limits without a wait from GitHub. Each doubles the next wait. */
const strikesKey = "github/rate-limit/strikes"

const decodeUntil = Schema.decodeUnknownOption(Schema.Finite)

const decodeStrikes = Schema.decodeUnknownOption(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))

const firstWait = Duration.toMillis(Duration.minutes(1))

const longestWait = Duration.toMillis(Duration.minutes(15))

export interface RateLimitApi {
  /** Fails with `RateLimited` while a wait recorded by any plugin instance lasts. */
  readonly check: Effect.Effect<void, GitHubFailure>
  /** Records a limited response. Without a time from GitHub, waits a minute, doubling up to 15. */
  readonly limited: (until: Option.Option<number>) => Effect.Effect<void>
  /** Records an answered request, so the next wait without a time starts at a minute again. */
  readonly answered: Effect.Effect<void>
}

export class RateLimit extends Context.Service<RateLimit, RateLimitApi>()(
  "opencode-pr-tracker/RateLimit",
) {}

const storedUntil = (storage: StorageDomain): Effect.Effect<number> =>
  Effect.map(storage.get(untilKey), (value) => Option.getOrElse(decodeUntil(value), () => 0))

const storedStrikes = (storage: StorageDomain): Effect.Effect<number> =>
  Effect.map(storage.get(strikesKey), (value) => Option.getOrElse(decodeStrikes(value), () => 0))

/** The end of a wait without a time from GitHub, counted as one more consecutive strike. */
const unhintedUntil = (storage: StorageDomain, now: number): Effect.Effect<number> =>
  Effect.gen(function* () {
    const strikes = yield* storedStrikes(storage)

    yield* storage.set(strikesKey, strikes + 1)

    return now + Math.min(firstWait * 2 ** strikes, longestWait)
  })

/**
 * The wait in plugin storage, which every plugin instance in the OpenCode service shares. The wait
 * and the doubling count are kept apart, so an answered request never erases a wait recorded
 * meanwhile.
 */
export function layer(storage: StorageDomain): Layer.Layer<RateLimit> {
  const now = Effect.map(Clock.currentTimeMillis, Math.floor)

  return Layer.succeed(
    RateLimit,
    RateLimit.of({
      answered: Effect.gen(function* () {
        if ((yield* storedStrikes(storage)) > 0) yield* storage.set(strikesKey, 0)
      }),
      check: Effect.gen(function* () {
        const waiting = (yield* now) < (yield* storedUntil(storage))

        return yield* waiting
          ? Effect.fail(new GitHubFailure({ diagnostic: "RateLimited" }))
          : Effect.void
      }),
      limited: (hinted) =>
        Effect.gen(function* () {
          const at = yield* now

          const next = yield* Option.match(hinted, {
            onNone: () => unhintedUntil(storage, at),
            onSome: Effect.succeed,
          })

          yield* storage.set(untilKey, Math.max(next, yield* storedUntil(storage)))
        }),
    }),
  )
}
