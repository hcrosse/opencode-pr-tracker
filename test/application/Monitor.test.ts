import { describe, expect, test } from "bun:test"

import { Effect, Exit, Fiber, Option, Stream } from "effect"
import { TestClock } from "effect/testing"

import type { SessionView } from "../../src/application/Monitor.ts"
import { openState, reported } from "../support/application.ts"
import {
  fetchedSince,
  merged,
  open,
  closed,
  other,
  run,
  scripted,
  watching,
  type App,
} from "../support/monitor.ts"

describe("Monitor polling", () => {
  test("fetches a pull request shared by two sessions once per poll", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [open])
        yield* watching(app, "b", [open])

        const before = github.fetches.length

        yield* app.monitor.poll

        return fetchedSince(github, before)
      }),
    )

    expect(result).toEqual(Exit.succeed([[1]]))
  })
})

describe("Monitor refresh intervals", () => {
  test("refreshes open and closed pull requests every 15 seconds and stops for merged ones", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [open, closed, merged])

        const before = github.fetches.length

        yield* app.monitor.poll
        yield* TestClock.adjust("10 seconds")
        yield* app.monitor.poll
        yield* TestClock.adjust("5 seconds")
        yield* app.monitor.poll

        return fetchedSince(github, before)
      }),
    )

    expect(result).toEqual(
      Exit.succeed([
        [1, 2, 3],
        [1, 2],
      ]),
    )
  })
})

describe("Monitor publishing", () => {
  test("publishes a session's view when a poll changes it", async () => {
    const result = await run(scripted(), (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [open])

        const next = yield* Effect.forkChild(Stream.runHead(app.monitor.changes))

        yield* Effect.yieldNow
        yield* app.monitor.poll

        const view = yield* Fiber.join(next)

        return Option.map(view, (changed: SessionView) =>
          changed.entries.map((entry) => entry.status._tag),
        )
      }),
    )

    expect(result).toEqual(Exit.succeed(Option.some(["Fresh"])))
  })
})

describe("Monitor views", () => {
  // Found by mutation: the sidebar draws Stacks from the membership each refresh reports.
  test("shows the Stack membership GitHub last reported", async () => {
    const github = scripted()
    const stack = { _tag: "Stack", id: "s", members: [open, other] } as const

    github.script(open, reported(open, openState, stack))
    github.script(other, reported(other, openState, stack))

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [open])
        yield* app.monitor.poll

        const view = yield* app.monitor.view("a")

        return view.entries.map((entry) =>
          Option.map(entry.membership, (membership) => membership._tag),
        )
      }),
    )

    expect(result).toEqual(Exit.succeed([Option.some("Stack"), Option.some("Stack")]))
  })
})
