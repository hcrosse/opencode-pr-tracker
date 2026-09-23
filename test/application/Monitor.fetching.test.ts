import { describe, expect, test } from "bun:test"

import { Effect, Exit, Fiber, Option } from "effect"

import { openState, reportOf, standalone } from "../support/application.ts"
import {
  closed,
  fetchedSince,
  open,
  other,
  run,
  scripted,
  statusOf,
  watching,
  type App,
} from "../support/monitor.ts"

describe("Monitor fetching", () => {
  test("merges refreshes requested during a fetch into one following fetch of all their pull requests", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [open, closed])
        yield* watching(app, "b", [other])

        const held = yield* github.hold(open)
        const first = yield* Effect.forkChild(app.monitor.refresh("a"))

        yield* held.started

        const before = github.fetches.length

        const later = yield* Effect.forkChild(
          Effect.all(
            [app.monitor.refresh("a"), app.monitor.refresh("b"), app.monitor.refresh("a")],
            {
              concurrency: "unbounded",
            },
          ),
        )

        // Let every later refresh reach the queue; the fakes yield as often as real I/O would.
        yield* Effect.repeat(Effect.yieldNow, { times: 20 })
        yield* held.release
        yield* Fiber.join(first)
        yield* Fiber.join(later)

        return fetchedSince(github, before)
      }),
    )

    expect(result).toEqual(Exit.succeed([[1, 2, 4]]))
  })
})

describe("Monitor recorded reports", () => {
  test("shows a session by fetching only pull requests it knows nothing about", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [open, closed])
        const before = github.fetches.length

        const view = yield* app.monitor.attached(
          "a",
          open,
          reportOf(open, openState, Option.some(standalone)),
        )

        return [fetchedSince(github, before), view.entries.map((entry) => entry.status._tag)]
      }),
    )

    expect(result).toEqual(Exit.succeed([[[2]], ["Fresh", "Fresh"]]))
  })

  test("shows a session whose pull requests are all known without fetching", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [open])
        const before = github.fetches.length

        yield* app.monitor.attached("a", open, reportOf(open, openState, Option.some(standalone)))

        return [fetchedSince(github, before), yield* statusOf(app)]
      }),
    )

    expect(result).toEqual(Exit.succeed([[], "Fresh"]))
  })
})

describe("Monitor polling alongside attaching", () => {
  test("keeps a status recorded while a poll is listing attachments, without fetching it again", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [open])
        yield* app.tracker.attach("b", { _tag: "Reference", ref: closed }, "/work")

        const before = github.fetches.length
        const polling = yield* Effect.forkChild(app.monitor.poll)

        // One yield lets the forked poll snapshot the cache and start listing attachments; it prunes
        // after `attached` has recorded #2.
        yield* Effect.yieldNow
        yield* app.monitor.attached(
          "b",
          closed,
          reportOf(closed, { _tag: "Closed" }, Option.some(standalone)),
        )
        yield* Fiber.join(polling)

        const view = yield* app.monitor.view("b")

        return [fetchedSince(github, before), view.entries.map((entry) => entry.status._tag)]
      }),
    )

    // The poll fetches #1, which session "a" has not seen yet; #2 was reported while attaching.
    expect(result).toEqual(Exit.succeed([[[1]], ["Fresh"]]))
  })
})
