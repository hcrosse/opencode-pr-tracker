import { Effect, Exit, Fiber, Option, Stream } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, test } from "vitest"

import type { SessionView } from "../../src/application/Monitor.ts"
import { requests, type Requests } from "../../src/server/Requests.ts"
import { memoryStorage } from "../support/application.ts"
import { closed, merged, open, run, scripted, type App } from "../support/monitor.ts"

const numbers = (view: SessionView): number[] => view.entries.map((entry) => entry.ref.number)

const over = (app: App): Requests => requests(app, { directory: "/work", layout: "full" })

/** The next view the monitor publishes for `sessionID` after `act`, which must publish one. */
const publishedAfter = Effect.fnUntraced(function* <A, E>(
  app: App,
  sessionID: string,
  act: Effect.Effect<A, E>,
): Effect.fn.Return<Option.Option<SessionView>, E> {
  const next = yield* app.monitor.changes.pipe(
    Stream.filter((view) => view.sessionID === sessionID),
    Stream.runHead,
    Effect.forkChild,
  )

  yield* Effect.yieldNow
  yield* act

  return yield* Fiber.join(next)
})

describe("attachment requests", () => {
  test("attaching publishes the session's view, so every client sees the change", async () => {
    const result = await run(scripted(), (app: App) =>
      publishedAfter(app, "a", over(app).attach("a", open.url)),
    )

    expect(Exit.map(result, Option.map(numbers))).toEqual(Exit.succeed(Option.some([1])))
  })

  test("detaching publishes the session's view without the pull request", async () => {
    const result = await run(scripted(), (app: App) =>
      Effect.gen(function* () {
        const changes = over(app)

        yield* changes.attach("a", open.url)
        yield* changes.attach("a", closed.url)

        return yield* publishedAfter(app, "a", changes.detach("a", closed.url))
      }),
    )

    expect(Exit.map(result, Option.map(numbers))).toEqual(Exit.succeed(Option.some([1])))
  })

  test("attaching fetches a standalone pull request once, reusing what discovery reported", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.map(over(app).attach("a", open.url), (changed) =>
        changed.view.entries.map((entry) => entry.status._tag),
      ),
    )

    expect(result).toEqual(Exit.succeed(["Fresh"]))
    expect(github.fetches).toEqual([[open.url]])
  })
})

describe("listing requests", () => {
  test("listing right after a restart fetches statuses instead of reporting them as loading", async () => {
    const storage = memoryStorage()
    const before = scripted()

    await run(before, (app: App) => over(app).attach("a", open.url), storage)
    await run(before, (app: App) => over(app).attach("a", merged.url), storage)

    const github = scripted()

    const result = await run(
      github,
      (app: App) =>
        Effect.map(over(app).list("a"), (view) => view.entries.map((entry) => entry.status._tag)),
      storage,
    )

    expect(result).toEqual(Exit.succeed(["Fresh", "Fresh"]))
    expect(github.fetches).toEqual([[open.url, merged.url]])
  })

  test("listing a session no terminal shows fetches statuses due for a refresh", async () => {
    const github = scripted()

    await run(github, (app: App) =>
      Effect.gen(function* () {
        const session = over(app)

        yield* session.attach("a", open.url)
        yield* TestClock.adjust("60 seconds")
        yield* session.list("a")
      }),
    )

    expect(github.fetches).toEqual([[open.url], [open.url]])
  })
})
