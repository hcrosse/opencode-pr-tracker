/**
 * Rate-limit waits in plugin storage, which every plugin instance in the OpenCode service shares.
 * Storage has no atomic update, so each wait is a key named for the epoch millisecond it ends, and
 * only the name counts. A key name always means the same end, so a write can only repeat an equal
 * wait, and removing a key whose end has passed can never remove a wait that still lasts.
 */
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Clock, Duration, Effect, Option, Ref, Schema } from "effect"

/** Epoch milliseconds before which no request is sent, as earlier versions record it. */
const legacyKey = "github/rate-limit/until"

const prefix = "github/rate-limit/until/"

/** GitHub's longest wait that is honored. */
export const longestHint = Duration.toMillis(Duration.hours(1))

/** Allowance past `longestHint` for a wait recorded a moment before this instance read the clock. */
const margin = Duration.toMillis(Duration.minutes(1))

const decodeLegacy = Schema.decodeUnknownOption(Schema.Finite)

/** The end a key names: a whole number of epoch milliseconds. */
const endOf = (key: string): Option.Option<number> =>
  Option.filter(Option.some(key.slice(prefix.length)), (name: string) => /^\d+$/u.test(name)).pipe(
    Option.map(Number),
    Option.filter(Number.isSafeInteger),
  )

/** Every key under `prefix`, page by page. */
const recordedKeys = Effect.fn("RateLimit.recordedWaits")(function* (storage: StorageDomain) {
  const keys: string[] = []
  let after = Option.none<string>()

  do {
    const page = yield* storage.scan(
      Option.match(after, {
        onNone: () => ({ prefix }),
        onSome: (key: string) => ({ after: key, prefix }),
      }),
    )

    keys.push(...page.entries.map((entry) => entry.key))
    after = Option.fromNullishOr(page.next)
  } while (Option.isSome(after))

  return keys
})

/** The recorded waits as this instance reads them, and the time it read them. */
interface Survey {
  readonly now: number
  /** The end of each recorded wait. */
  readonly ends: readonly number[]
  /** Keys whose end has passed, and keys that name no end. */
  readonly removable: readonly string[]
}

export interface WaitsApi {
  /** The latest end of any recorded wait, or 0, and the time it was read. */
  readonly latest: Effect.Effect<{ readonly now: number; readonly until: number }>
  /** Records a wait unless one lasting as long is recorded, and removes waits that have ended. */
  readonly record: (until: number) => Effect.Effect<void>
}

/** Plugin storage, and the keys this instance has already logged as naming no plausible end. */
interface Instance {
  readonly storage: StorageDomain
  readonly noticed: Ref.Ref<ReadonlySet<string>>
}

interface Named {
  readonly end: number
  readonly key: string
}

/** Logs `key` the first time this instance finds it names no plausible end. */
const notice = Effect.fn("RateLimit.noticeImplausible")(function* (
  { noticed }: Instance,
  key: string,
) {
  const first = yield* Ref.modify(noticed, (seen: ReadonlySet<string>) =>
    seen.has(key) ? [false, seen] : [true, new Set([...seen, key])],
  )

  if (first)
    yield* Effect.logWarning("Stored rate-limit wait names no plausible end").pipe(
      Effect.annotateLogs({ key }),
    )
})

/** Reads the clock only after the scan, so a wait recorded before the scan is never too far ahead. */
const survey = Effect.fn("RateLimit.survey")(function* (instance: Instance) {
  const keys = yield* recordedKeys(instance.storage)
  const now = Math.floor(yield* Clock.currentTimeMillis)

  const plausibleEnd = (key: string): Option.Option<number> =>
    Option.filter(endOf(key), (end: number) => end <= now + longestHint + margin)

  const named = keys.flatMap((key: string) =>
    Option.toArray(Option.map(plausibleEnd(key), (end: number): Named => ({ end, key }))),
  )

  const implausible = keys.filter((key: string) => Option.isNone(plausibleEnd(key)))

  yield* Effect.forEach(implausible, (key: string) => notice(instance, key), { discard: true })

  const result: Survey = {
    ends: named.map((wait: Named) => wait.end),
    now,
    removable: [
      ...named.filter((wait: Named) => wait.end <= now).map((wait: Named) => wait.key),
      ...keys.filter((key: string) => Option.isNone(endOf(key))),
    ],
  }

  return result
})

const latest = Effect.fn("RateLimit.latest")(function* (instance: Instance) {
  const { ends, now } = yield* survey(instance)
  let until = Option.getOrElse(decodeLegacy(yield* instance.storage.get(legacyKey)), () => 0)

  for (const end of ends) until = Math.max(until, end)

  return { now, until }
})

/**
 * Removes keys whose named end has passed, which no later write can extend, and keys that name no
 * end, which this code never writes. A key naming an end too far ahead stays: by the time this
 * instance removed it, another might already rely on it.
 */
const record = Effect.fn("RateLimit.record")(function* (instance: Instance, until: number) {
  const { storage } = instance
  const { ends, now, removable } = yield* survey(instance)

  if (until > now && ends.every((end: number) => end < until))
    yield* storage.set(`${prefix}${until}`, until)

  yield* Effect.forEach(removable, (key: string) => storage.remove(key), { discard: true })
})

/**
 * The waits one plugin instance reads and records. A key that names no end, or one too far ahead
 * to have been recorded, is ignored and logged once per instance. One naming no end is removed by
 * the next recorded wait; one too far ahead is honored once within reach, like any wait. The earlier single key is read, never written or removed: older instances still
 * update it by reading and writing it back.
 */
export const makeWaits = Effect.fn("RateLimit.makeWaits")(function* (storage: StorageDomain) {
  const instance: Instance = { noticed: yield* Ref.make<ReadonlySet<string>>(new Set()), storage }

  const waits: WaitsApi = {
    latest: latest(instance),
    record: (until: number) => record(instance, until),
  }

  return waits
})
