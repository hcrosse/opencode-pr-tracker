import { describe, expect, test } from "bun:test"

import { Effect, Exit } from "effect"
import { TestClock } from "effect/testing"

import {
  checking,
  fetchedSince,
  other,
  run,
  scripted,
  watching,
  type App,
} from "../support/monitor.ts"

describe("Monitor order of due pull requests", () => {
  test("fetches the pull requests failing longest first", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [checking, other])
        github.script(other, { _tag: "Failed", charged: true, diagnostic: "GitHubUnavailable" })

        const before = github.fetches.length

        yield* app.monitor.poll

        // #5's checks are running and #4 failed once, so both are due again in 15 seconds.
        yield* TestClock.adjust("15 seconds")
        yield* app.monitor.watch("a")
        yield* app.monitor.poll

        return fetchedSince(github, before)
      }),
    )

    expect(result).toEqual(
      Exit.succeed([
        [5, 4],
        [4, 5],
      ]),
    )
  })
})

describe("Monitor backoff after charged failures", () => {
  test("waits longer after each charged failure", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [other])
        github.script(other, { _tag: "Failed", charged: true, diagnostic: "GitHubUnavailable" })

        const before = github.fetches.length

        // Polls at 0:00, 0:15, 0:30 and 0:45; failures make #4 due at 0:15 and then 0:45.
        for (const elapsed of ["0 seconds", "15 seconds", "15 seconds", "15 seconds"] as const) {
          yield* TestClock.adjust(elapsed)
          yield* app.monitor.watch("a")
          yield* app.monitor.poll
        }

        return fetchedSince(github, before).length
      }),
    )

    expect(result).toEqual(Exit.succeed(3))
  })
})
