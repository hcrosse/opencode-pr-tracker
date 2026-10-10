import { describe, expect, test } from "bun:test"

import { Effect, Exit, type Schema } from "effect"

import type { GitHubApi } from "../../../src/ports/GitHub.ts"
import { memoryStorage, type StorageFake } from "../../support/application.ts"
import { httpClient, requestsAt, runClient, type HttpFake } from "../../support/github.ts"
import { captureLogs, type Logged } from "../../support/logs.ts"

/** The single key earlier versions record a wait in. Recorded waits now have a key each. */
const legacyKey = "github/rate-limit/until"

const strikesKey = "github/rate-limit/strikes"

const answered = (): Response => Response.json({ data: { pr0: null } })

const secondaryLimit = (): Response =>
  new Response("You have exceeded a secondary rate limit", { status: 403 })

/** Plugin storage that already holds `values`, by key. */
function storedWith(values: Readonly<Record<string, Schema.Json>>): StorageFake {
  const storage = memoryStorage()

  for (const [key, value] of Object.entries(values)) Effect.runSync(storage.storage.set(key, value))

  return storage
}

interface Fetched {
  readonly requests: readonly number[]
  /** The annotations of each warning about malformed stored state. */
  readonly warnings: readonly Logged["annotations"][]
  readonly lines: readonly Logged[]
}

/** Fetches at each of `times`, returning the requests sent so far after each and the logs. */
async function fetchesAt(
  http: HttpFake,
  storage: StorageFake,
  times: readonly number[],
): Promise<Exit.Exit<Fetched>> {
  const logs = captureLogs()

  const result = await runClient({ http, storage }, (github: GitHubApi) =>
    requestsAt(
      http,
      times,
    )(github).pipe(
      Effect.provide(logs.layer),
      Effect.map((requests: readonly number[]) => ({
        lines: logs.lines(),
        requests,
        warnings: logs
          .lines()
          .flatMap((line: Logged) =>
            line.message === "Stored rate-limit state is malformed" ? [line.annotations] : [],
          ),
      })),
    ),
  )

  return result
}

const requestsAndWarnings = (fetched: Fetched): Omit<Fetched, "lines"> => ({
  requests: fetched.requests,
  warnings: fetched.warnings,
})

describe("GitHub client single-key waits that cannot be read", () => {
  test.each([
    ["a word", "soon", "string"],
    ["a number written as text", "99999999999999", "string"],
    ["a negative time", -5, "negative number"],
    ["a fraction", 1.5, "fractional number"],
    ["ten hours away", 36_000_000, "number too far ahead"],
  ] as const)(
    "waits a minute, warning once, when the single-key wait is %s",
    async (_, value, kind) => {
      const http = httpClient(answered)
      const storage = storedWith({ [legacyKey]: value })

      const result = await fetchesAt(http, storage, [0, 30_000, 59_999, 60_000, 90_000])

      expect(Exit.map(result, requestsAndWarnings)).toEqual(
        Exit.succeed({
          requests: [0, 0, 0, 1, 2],
          warnings: [{ key: legacyKey, replacement: 60_000, stored: kind }],
        }),
      )
      expect(storage.values.get(legacyKey)).toBe(value)
    },
  )
})

describe("GitHub client single-key waits too far ahead", () => {
  test("keeps ignoring the same single-key wait once it comes within an hour", async () => {
    const http = httpClient(answered)
    const tenHours = 36_000_000
    const storage = storedWith({ [legacyKey]: tenHours })

    // At 9h1m the stored wait is under an hour away, but it is the value already found malformed.
    const result = await fetchesAt(http, storage, [0, 60_000, 3_660_000, 32_460_000])

    expect(Exit.map(result, requestsAndWarnings)).toEqual(
      Exit.succeed({
        requests: [0, 1, 2, 3],
        warnings: [{ key: legacyKey, replacement: 60_000, stored: "number too far ahead" }],
      }),
    )
  })
})

describe("GitHub client stored strike counts that cannot be read", () => {
  test.each([
    ["a word", "many", "string"],
    ["negative", -1, "negative number"],
  ] as const)("waits the longest time when the stored count is %s", async (_, value, kind) => {
    const http = httpClient(secondaryLimit)
    const storage = storedWith({ [strikesKey]: value })

    const result = await fetchesAt(http, storage, [0, 60_000, 899_999, 900_000])

    expect(Exit.map(result, requestsAndWarnings)).toEqual(
      Exit.succeed({
        requests: [1, 1, 1, 2],
        warnings: [{ key: strikesKey, replacement: 4, stored: kind }],
      }),
    )
  })

  test("starts the count again, with a warning, once a request is answered", async () => {
    const storage = storedWith({ [strikesKey]: null })

    const result = await fetchesAt(httpClient(answered), storage, [0])

    expect(Exit.map(result, (fetched: Fetched) => fetched.warnings)).toEqual(
      Exit.succeed([{ key: strikesKey, replacement: 4, stored: "null" }]),
    )
    expect(storage.values.get(strikesKey)).toBe(0)
  })
})

describe("GitHub client logs about stored state", () => {
  test("never show the stored value", async () => {
    const secret = "ghp_sentinel0123456789"
    const storage = storedWith({ [strikesKey]: secret, [legacyKey]: secret })

    const result = await fetchesAt(httpClient(secondaryLimit), storage, [0, 60_000])

    const logged = Exit.map(result, (fetched: Fetched) => ({
      leaked: fetched.lines.some((line: Logged) => JSON.stringify(line).includes(secret)),
      warnings: fetched.warnings.length,
    }))

    expect(logged).toEqual(Exit.succeed({ leaked: false, warnings: 2 }))
  })
})
