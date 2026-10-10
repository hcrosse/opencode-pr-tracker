import { describe, expect, test } from "bun:test"

import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Effect, Exit, Logger, Option } from "effect"
import { TestClock } from "effect/testing"

import { layer, RateLimit, type RateLimitApi } from "../../../src/adapters/github/RateLimit.ts"
import { memoryStorage } from "../../support/application.ts"

const minute = 60_000

const hour = 3_600_000

const waitKeys = "github/rate-limit/until"

/** One plugin instance's rate limit over `storage`. */
const instance = (storage: StorageDomain): Effect.Effect<RateLimitApi> =>
  Effect.provide(Effect.service(RateLimit), layer(storage))

/** Where `interleaved` runs another instance's work. */
type Moment = "after the first read" | "before the first read" | "before the first write"

/** `storage`, except that `meanwhile` runs once, at `moment`, among reads and writes of waits. */
function interleaved(
  storage: StorageDomain,
  meanwhile: Effect.Effect<void>,
  moment: Moment = "after the first read",
): StorageDomain {
  let pending = true

  const first = (key: string, at: Moment): Effect.Effect<void> => {
    if (!key.startsWith(waitKeys) || !pending || at !== moment) return Effect.void

    pending = false

    return meanwhile
  }

  const read = <A>(key: string, reading: Effect.Effect<A>): Effect.Effect<A> =>
    first(key, "before the first read").pipe(
      Effect.andThen(reading),
      Effect.tap(() => first(key, "after the first read")),
    )

  return {
    get: (key: string) => read(key, storage.get(key)),
    remove: (key: string) =>
      Effect.andThen(first(key, "before the first write"), storage.remove(key)),
    scan: (options) => read(options.prefix, storage.scan(options)),
    set: (key: string, value) =>
      Effect.andThen(first(key, "before the first write"), storage.set(key, value)),
  }
}

async function run<A, E>(effect: Effect.Effect<A, E>): Promise<Exit.Exit<A, E>> {
  const exit = await Effect.runPromiseExit(
    effect.pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([]))),
  )

  return exit
}

describe("rate-limit waits shared by plugin instances", () => {
  test("keeps an instance's hour-long wait recorded while another records a minute", async () => {
    const { storage } = memoryStorage()

    const result = await run(
      Effect.gen(function* () {
        const longer = yield* instance(storage)
        const shorter = yield* instance(interleaved(storage, longer.limited(Option.some(hour))))

        yield* shorter.limited(Option.none())
        yield* TestClock.setTime(2 * minute)

        return yield* (yield* instance(storage)).check
      }),
    )

    expect(Exit.findErrorOption(result)).toMatchObject({ value: { diagnostic: "RateLimited" } })
  })

  test("honors a wait an earlier version stored under the single key", async () => {
    const { storage } = memoryStorage()

    const result = await run(
      Effect.gen(function* () {
        yield* storage.set(waitKeys, hour)
        yield* (yield* instance(storage)).limited(Option.some(minute))
        yield* TestClock.setTime(2 * minute)

        return yield* (yield* instance(storage)).check
      }),
    )

    expect(Exit.findErrorOption(result)).toMatchObject({ value: { diagnostic: "RateLimited" } })
  })
})

describe("rate-limit wait cleanup", () => {
  test("removes waits that have ended when recording a new one", async () => {
    const fake = memoryStorage()

    await run(
      Effect.gen(function* () {
        yield* (yield* instance(fake.storage)).limited(Option.some(minute))
        yield* (yield* instance(fake.storage)).limited(Option.some(2 * minute))
        yield* TestClock.setTime(3 * minute)
        yield* (yield* instance(fake.storage)).limited(Option.some(4 * minute))
      }),
    )

    const waits = [...fake.values.keys()].filter((key: string) => key.startsWith(waitKeys))

    expect(waits.map((key: string) => fake.values.get(key))).toEqual([4 * minute])
  })
})

describe("rate-limit wait repair under concurrent instances", () => {
  test("keeps an hour-long wait recorded after another instance read the clock", async () => {
    const { storage } = memoryStorage()

    const result = await run(
      Effect.gen(function* () {
        const recorder = yield* instance(storage)

        const later = Effect.andThen(
          TestClock.adjust(10 * minute),
          recorder.limited(Option.some(10 * minute + hour)),
        )

        yield* Effect.exit(
          (yield* instance(interleaved(storage, later, "before the first read"))).check,
        )
        yield* TestClock.setTime(12 * minute)

        return yield* (yield* instance(storage)).check
      }),
    )

    expect(Exit.findErrorOption(result)).toMatchObject({ value: { diagnostic: "RateLimited" } })
  })
})

describe("rate-limit waits beside a malformed one", () => {
  test("keeps a wait recorded under a key another instance read as malformed", async () => {
    const { storage } = memoryStorage()

    const result = await run(
      Effect.gen(function* () {
        yield* storage.set(`${waitKeys}/${hour}`, "malformed")

        const recorder = yield* instance(storage)

        yield* Effect.exit(
          (yield* instance(interleaved(storage, recorder.limited(Option.some(hour))))).check,
        )
        yield* TestClock.setTime(2 * minute)

        return yield* (yield* instance(storage)).check
      }),
    )

    expect(Exit.findErrorOption(result)).toMatchObject({ value: { diagnostic: "RateLimited" } })
  })
})

describe("rate-limit waits while an instance removes a malformed one", () => {
  test("keeps other instances stopped by a recorded wait meanwhile", async () => {
    const fake = memoryStorage()
    let meanwhile: Exit.Exit<void, unknown> = Exit.void

    await run(
      Effect.gen(function* () {
        yield* fake.storage.set(`${waitKeys}/odd`, "malformed")
        yield* fake.storage.set(`${waitKeys}/${hour}`, hour)

        const other = yield* instance(fake.storage)

        const checked = Effect.map(Effect.exit(other.check), (exit) => {
          meanwhile = exit
        })

        const remover = yield* instance(
          interleaved(fake.storage, checked, "before the first write"),
        )

        yield* remover.limited(Option.some(minute))
      }),
    )

    expect(Exit.findErrorOption(meanwhile)).toMatchObject({ value: { diagnostic: "RateLimited" } })
    expect([...fake.values.keys()]).toEqual([`${waitKeys}/${hour}`])
  })
})

describe("rate-limit waits named far ahead", () => {
  test("keeps a far-ahead wait another instance relied on once it came within reach", async () => {
    const { storage } = memoryStorage()

    const result = await run(
      Effect.gen(function* () {
        yield* storage.set(`${waitKeys}/${2 * hour}`, 2 * hour)

        const relying = yield* instance(storage)

        const later = Effect.andThen(
          TestClock.setTime(hour),
          relying.limited(Option.some(2 * hour)),
        )

        const stale = yield* instance(interleaved(storage, later, "before the first write"))

        yield* stale.limited(Option.some(minute))
        yield* TestClock.setTime(hour + 30 * minute)

        return yield* (yield* instance(storage)).check
      }),
    )

    expect(Exit.findErrorOption(result)).toMatchObject({ value: { diagnostic: "RateLimited" } })
  })
})
