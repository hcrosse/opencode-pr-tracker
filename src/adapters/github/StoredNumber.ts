/**
 * A whole number of rate-limit state kept under one plugin storage key, which every plugin
 * instance shares. Storage has no atomic update, so a value is never written back just because it
 * is malformed: another instance may have just stored a valid one. This instance uses a
 * replacement instead, held until the stored value changes, and warns once per value.
 */
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Array as Arr, Clock, Effect, Option, Predicate, Ref, Schema } from "effect"

const decodeStored = Schema.decodeUnknownOption(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))

/** How a stored value is malformed, for logs, which must not show the value itself. */
function malformation(raw: Schema.Json): string {
  if (Predicate.isNull(raw)) return "null"

  if (Arr.isArray(raw)) return "array"

  if (Predicate.isString(raw)) return "string"

  if (Predicate.isBoolean(raw)) return "boolean"

  if (!Predicate.isNumber(raw)) return "object"

  if (raw < 0) return "negative number"

  return Number.isInteger(raw) ? "number too far ahead" : "fractional number"
}

/** A malformed stored value as this instance first saw it, and the number used in its place. */
interface Held {
  readonly stored: string
  readonly replacement: number
}

export interface StoredNumberOptions {
  readonly storage: StorageDomain
  readonly key: string
  /** Whether a nonnegative whole number is one this code could have stored by `now`. */
  readonly valid: (value: number, now: number) => boolean
  /** The number to use at `now` in place of a malformed value. */
  readonly replacement: (now: number) => number
}

export interface StoredNumber extends StoredNumberOptions {
  readonly held: Ref.Ref<Option.Option<Held>>
}

export const storedNumber = (options: StoredNumberOptions): Effect.Effect<StoredNumber> =>
  Effect.map(Ref.make(Option.none<Held>()), (held) => ({
    held,
    key: options.key,
    replacement: options.replacement,
    storage: options.storage,
    valid: options.valid,
  }))

/**
 * The number to use for `raw`, whether it is newly found malformed, and what to hold. A value
 * found malformed once stays so, even once the clock would make a wait that far ahead plausible.
 */
const judged =
  (stored: StoredNumber, raw: Schema.Json | undefined, now: number) =>
  (held: Option.Option<Held>): readonly [readonly [number, boolean], Option.Option<Held>] => {
    if (Predicate.isUndefined(raw)) return [[0, false], Option.none()]

    const seen = JSON.stringify(raw)

    if (Option.isSome(held) && held.value.stored === seen)
      return [[held.value.replacement, false], held]

    const decoded = Option.filter(decodeStored(raw), (value: number) => stored.valid(value, now))

    if (Option.isSome(decoded)) return [[decoded.value, false], Option.none()]

    const replacement = stored.replacement(now)

    return [[replacement, true], Option.some({ replacement, stored: seen })]
  }

/**
 * The stored number, or 0 if none is stored, and the time it was judged at. The clock is read only
 * after the value is, so a value stored meanwhile is never judged against an earlier time.
 */
export const readStored = Effect.fn("RateLimit.readStored")(function* (stored: StoredNumber) {
  const raw = yield* stored.storage.get(stored.key)
  const now = Math.floor(yield* Clock.currentTimeMillis)
  const [value, malformed] = yield* Ref.modify(stored.held, judged(stored, raw, now))

  if (malformed && !Predicate.isUndefined(raw))
    yield* Effect.logWarning("Stored rate-limit state is malformed").pipe(
      Effect.annotateLogs({ key: stored.key, replacement: value, stored: malformation(raw) }),
    )

  return { now, value }
})
