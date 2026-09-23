import { describe, expect, test } from "bun:test"

import { Effect, Exit, Option } from "effect"
import { TestClock } from "effect/testing"

import {
  fetchedSince,
  merged,
  open,
  closed,
  other,
  run,
  scripted,
  statusOf,
  watching,
  type App,
} from "../support/monitor.ts"

describe("Monitor failures", () => {
  test("keeps the last status marked stale while refreshes fail, then withdraws it after five minutes", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [open])
        yield* app.monitor.poll
        github.failRequests(Option.some("GitHubUnavailable"))

        const seen: string[] = []

        for (const elapsed of ["15 seconds", "4 minutes", "45 seconds", "15 seconds"] as const) {
          yield* TestClock.adjust(elapsed)
          yield* app.monitor.poll
          seen.push(yield* statusOf(app))
        }

        return seen
      }),
    )

    // Failures begin at 0:15; 5:00 is 4:45 of failing, 5:15 is five minutes.
    expect(result).toEqual(Exit.succeed(["Stale", "Stale", "Stale", "Unavailable"]))
  })
})

describe("Monitor refresh", () => {
  test("refreshes a session now on request, except its merged pull requests", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [open, closed, merged])
        yield* app.monitor.poll

        const before = github.fetches.length

        yield* app.monitor.refresh("a")

        return fetchedSince(github, before)
      }),
    )

    expect(result).toEqual(Exit.succeed([[1, 2]]))
  })
})

describe("Monitor forgetting", () => {
  test("stops refreshing forgotten sessions and detached pull requests", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [open, closed])
        yield* watching(app, "b", [other])
        yield* app.monitor.poll
        yield* app.tracker.detach("a", { _tag: "Reference", ref: closed })
        yield* app.monitor.forget("b")

        const before = github.fetches.length

        yield* TestClock.adjust("15 seconds")
        yield* app.monitor.poll

        return fetchedSince(github, before)
      }),
    )

    expect(result).toEqual(Exit.succeed([[1]]))
  })
})
