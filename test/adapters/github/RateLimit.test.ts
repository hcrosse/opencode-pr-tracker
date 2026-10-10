import { describe, expect, test } from "bun:test"

import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Effect, Exit, Logger, Option, type Schema } from "effect"
import { TestClock } from "effect/testing"

import { layer, RateLimit, type RateLimitApi } from "../../../src/adapters/github/RateLimit.ts"
import { memoryStorage } from "../../support/application.ts"

/** The single key earlier versions record a wait in. */
const untilKey = "github/rate-limit/until"

const hour = 3_600_000

/** One plugin instance's rate limit over `storage`. */
const instance = (storage: StorageDomain): Effect.Effect<RateLimitApi> =>
  Effect.provide(
    Effect.gen(function* () {
      return yield* RateLimit
    }),
    layer(storage),
  )

/** `storage`, except that its first read of `key` runs `meanwhile` before reading. */
function interleaved(
  storage: StorageDomain,
  key: string,
  meanwhile: Effect.Effect<void>,
): StorageDomain {
  let pending = true

  return {
    get: (read: string) =>
      Effect.andThen(
        Effect.suspend(() => {
          if (read !== key || !pending) return Effect.void

          pending = false

          return meanwhile
        }),
        storage.get(read),
      ),
    remove: (removed: string) => storage.remove(removed),
    scan: (options) => storage.scan(options),
    set: (written: string, value: Schema.Json) => storage.set(written, value),
  }
}

describe("rate limits shared by plugin instances", () => {
  test("keeps a wait another instance recorded while this one read a malformed single key", async () => {
    const shared = memoryStorage()

    const program = Effect.gen(function* () {
      yield* shared.storage.set(untilKey, "soon")

      const other = yield* instance(shared.storage)
      const limitedForAnHour = other.limited(Option.some(hour))
      const reader = yield* instance(interleaved(shared.storage, untilKey, limitedForAnHour))

      const first = yield* Effect.exit(reader.check)

      yield* TestClock.setTime(60_000)

      const later = [yield* Effect.exit(reader.check), yield* Effect.exit(other.check)]

      return [first, ...later].map((exit) => Exit.isFailure(exit))
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide([TestClock.layer(), Logger.layer([])])),
    )

    expect(result).toEqual([true, true, true])
    expect([...shared.values]).toEqual([
      [untilKey, "soon"],
      [`${untilKey}/${String(hour)}`, hour],
    ])
  })
})

describe("rate limits recorded by an older instance", () => {
  test("honors an hour's single-key wait stored while this instance read the clock", async () => {
    const shared = memoryStorage()

    const program = Effect.gen(function* () {
      const olderInstanceWaits = Effect.andThen(
        TestClock.setTime(1000),
        shared.storage.set(untilKey, 1000 + hour),
      )

      const reader = yield* instance(interleaved(shared.storage, untilKey, olderInstanceWaits))
      const first = yield* Effect.exit(reader.check)

      yield* TestClock.setTime(60_000)

      return [first, yield* Effect.exit(reader.check)].map((exit) => Exit.isFailure(exit))
    })

    const result = await Effect.runPromise(
      program.pipe(Effect.provide([TestClock.layer(), Logger.layer([])])),
    )

    expect(result).toEqual([true, true])
  })
})
