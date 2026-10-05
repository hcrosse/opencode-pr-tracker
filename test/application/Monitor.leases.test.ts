import { describe, expect, test } from "bun:test"

import { Effect, Exit } from "effect"
import { TestClock } from "effect/testing"

import { requests } from "../../src/server/Requests.ts"
import type { GitHubScript } from "../support/application.ts"
import { checking, fetchedSince, run, scripted, watching, type App } from "../support/monitor.ts"

/** Polls once after the clock moves by `elapsed`, and returns the pull requests it fetched. */
const pollAfter = (
  github: GitHubScript,
  app: App,
  elapsed: "0 seconds" | "15 seconds" | "30 seconds",
): Effect.Effect<number[][]> =>
  Effect.gen(function* () {
    const before = github.fetches.length

    yield* TestClock.adjust(elapsed)
    yield* app.monitor.poll

    return fetchedSince(github, before)
  })

describe("Monitor leases", () => {
  test("polls a watched session until its lease lapses, and again once it is renewed", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [checking])

        const fetched = [
          yield* pollAfter(github, app, "0 seconds"),
          yield* pollAfter(github, app, "15 seconds"),
          yield* pollAfter(github, app, "30 seconds"),
        ]

        yield* app.monitor.watch("a")

        return [...fetched, yield* pollAfter(github, app, "0 seconds")]
      }),
    )

    // The lease renewed at 0:00 lapses at 0:45.
    expect(result).toEqual(Exit.succeed([[[5]], [[5]], [], [[5]]]))
  })
})

describe("Monitor sessions without a lease", () => {
  test("does not poll a session that was only shown after attaching or detaching", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* requests(app, { directory: "/work", layout: "default" }).attach("a", checking.url)
        yield* app.tracker.attach("b", { _tag: "Reference", ref: checking }, "/work")
        yield* app.monitor.show("b")

        return yield* pollAfter(github, app, "15 seconds")
      }),
    )

    expect(result).toEqual(Exit.succeed([]))
  })

  test("polls a session an agent listed until its lease lapses", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* app.tracker.attach("b", { _tag: "Reference", ref: checking }, "/work")
        yield* requests(app, { directory: "/work", layout: "default" }).list("b")

        return [
          yield* pollAfter(github, app, "15 seconds"),
          yield* pollAfter(github, app, "30 seconds"),
        ]
      }),
    )

    // Listed at 0:00, so the lease lapses at 0:45.
    expect(result).toEqual(Exit.succeed([[[5]], []]))
  })
})
