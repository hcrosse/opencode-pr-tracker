import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Effect, Exit, Logger, Option, Predicate } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"

import { layer, RateLimit, type RateLimitApi } from "../../../src/adapters/github/RateLimit.ts"
import { memoryStorage, type StorageFake } from "../../support/application.ts"

const minute = 60_000

const hour = 3_600_000

const waitPrefix = "github/rate-limit/until/"

const waitKey = (until: number): string => `${waitPrefix}${until}`

/** One plugin instance's rate limit over `storage`, which scans a page of one key at a time. */
const instance = (storage: StorageDomain): Effect.Effect<RateLimitApi> =>
  Effect.provide(
    Effect.service(RateLimit),
    layer({
      get: (key: string) => storage.get(key),
      remove: (key: string) => storage.remove(key),
      scan: ({ after, prefix }) =>
        storage.scan(
          Predicate.isUndefined(after) ? { limit: 1, prefix } : { after, limit: 1, prefix },
        ),
      set: (key: string, value) => storage.set(key, value),
    }),
  )

/** Runs `effect` from time 0, returning its exit and each log line as Effect's JSON logger writes it. */
async function run<A, E>(
  effect: Effect.Effect<A, E>,
): Promise<readonly [Exit.Exit<A, E>, readonly string[]]> {
  const lines: string[] = []

  const capture = Logger.map(Logger.formatJson, (line: string) => {
    lines.push(line)
  })

  const exit = await Effect.runPromiseExit(
    effect.pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([capture]))),
  )

  return [exit, lines]
}

const waitsIn = (fake: StorageFake): readonly string[] =>
  [...fake.values.keys()].filter((key: string) => key.startsWith(waitPrefix)).toSorted()

describe("rate-limit waits over several scan pages", () => {
  test("honors the longest wait when it is on a later page", async () => {
    const fake = memoryStorage()

    const [exit] = await run(
      Effect.gen(function* () {
        yield* fake.storage.set(waitKey(minute), minute)
        yield* fake.storage.set(waitKey(15 * minute), 15 * minute)
        yield* TestClock.setTime(2 * minute)

        return yield* (yield* instance(fake.storage)).check
      }),
    )

    expect(Exit.findErrorOption(exit)).toMatchObject({ value: { diagnostic: "RateLimited" } })
  })

  test("removes ended waits from every page", async () => {
    const fake = memoryStorage()

    await run(
      Effect.gen(function* () {
        for (const until of [minute, 2 * minute, 3 * minute])
          yield* fake.storage.set(waitKey(until), until)

        yield* TestClock.setTime(4 * minute)
        yield* (yield* instance(fake.storage)).limited(Option.some(5 * minute))
      }),
    )

    expect(waitsIn(fake)).toEqual([waitKey(5 * minute)])
  })
})

const warningsIn = (lines: readonly string[]): readonly string[] =>
  lines.filter((line: string) => line.includes("rate-limit wait names no plausible end"))

describe("rate-limit wait keys that name no plausible end", () => {
  test("ignores a key naming no end, logging it once without its value, until a limit removes it", async () => {
    const fake = memoryStorage()

    const [exit, lines] = await run(
      Effect.gen(function* () {
        yield* fake.storage.set(`${waitPrefix}odd`, "secret-stored-text")

        const limit = yield* instance(fake.storage)

        yield* limit.check
        yield* limit.check

        const writes = fake.writes()

        yield* limit.limited(Option.some(minute))

        return writes
      }),
    )

    expect(exit).toEqual(Exit.succeed(1))
    expect(warningsIn(lines)).toHaveLength(1)
    expect(warningsIn(lines).join("\n")).toContain(`${waitPrefix}odd`)
    expect(lines.join("\n")).not.toContain("secret-stored-text")
    expect(waitsIn(fake)).toEqual([waitKey(minute)])
  })
})

describe("rate-limit wait keys naming an end far ahead", () => {
  test("ignores a key naming an end over an hour ahead until it comes within reach", async () => {
    const fake = memoryStorage()

    const [exit, lines] = await run(
      Effect.gen(function* () {
        yield* fake.storage.set(waitKey(3 * hour), 3 * hour)

        const limit = yield* instance(fake.storage)

        yield* limit.check
        yield* limit.limited(Option.some(minute))
        yield* TestClock.setTime(2 * hour)

        const within = yield* Effect.exit(limit.check)

        yield* TestClock.setTime(3 * hour)
        yield* limit.limited(Option.some(3 * hour + minute))

        return within
      }),
    )

    expect(Exit.isSuccess(exit) && Exit.findErrorOption(exit.value)).toMatchObject({
      value: { diagnostic: "RateLimited" },
    })
    expect(warningsIn(lines)).toHaveLength(1)
    expect(waitsIn(fake)).toEqual([waitKey(3 * hour + minute)])
  })
})

describe("rate-limit wait keys naming an end just over an hour ahead", () => {
  test("honors a key naming an end just over an hour ahead, within the margin", async () => {
    const fake = memoryStorage()

    const [exit, lines] = await run(
      Effect.gen(function* () {
        yield* fake.storage.set(waitKey(hour + minute / 2), "ignored")

        return yield* (yield* instance(fake.storage)).check
      }),
    )

    expect(Exit.findErrorOption(exit)).toMatchObject({ value: { diagnostic: "RateLimited" } })
    expect(warningsIn(lines)).toEqual([])
    expect(waitsIn(fake)).toEqual([waitKey(hour + minute / 2)])
  })
})
