import { describe, expect, test } from "bun:test"

import { Effect, Exit } from "effect"
import { TestClock } from "effect/testing"

import type { PullRequestRef } from "../../src/domain/PullRequest.ts"
import {
  memoryStorage,
  openState,
  reported,
  ScriptedGitHub,
  standalone,
} from "../support/application.ts"
import { numbersOf, ref, run, scriptAll, stackOf, watching, type App } from "../support/monitor.ts"

/**
 * #5, #6 and #7 form a Stack; #1 and #8 to #13 are standalone. Attaching them in this order puts
 * #10 and #12 apart from the Stack, as when they are later linked into it with `gh stack link`.
 */
function beforeLinking(): ScriptedGitHub {
  const github = new ScriptedGitHub()

  for (const number of [1, 8, 9, 10, 11, 12, 13]) {
    github.script(ref(number), reported(ref(number), openState, standalone))
  }

  scriptAll(github, [5, 6, 7], stackOf("s", [5, 6, 7]))

  return github
}

const attachedInOrder: readonly PullRequestRef[] = [1, 5, 8, 9, 10, 11, 12, 13].map((number) =>
  ref(number),
)

describe("Monitor Stack order", () => {
  test("stores a Stack's members together once GitHub reports them linked", async () => {
    const github = beforeLinking()
    const storage = memoryStorage()

    const result = await run(
      github,
      (app: App) =>
        Effect.gen(function* () {
          yield* watching(app, "a", attachedInOrder)
          scriptAll(github, [5, 6, 7, 10, 12], stackOf("s", [5, 6, 7, 10, 12]))

          yield* TestClock.adjust("15 seconds")
          yield* app.monitor.poll

          const stored = (yield* app.tracker.list("a")).map((attachment) => attachment.ref.number)

          return { stored, viewed: yield* numbersOf(app) }
        }),
      storage,
    )

    const grouped = [1, 5, 6, 7, 10, 12, 8, 9, 11, 13]

    expect(result).toEqual(Exit.succeed({ stored: grouped, viewed: grouped }))
  })
})

describe("Monitor Stack order writes", () => {
  test("writes nothing on later polls while membership stays the same", async () => {
    const github = beforeLinking()
    const storage = memoryStorage()

    const result = await run(
      github,
      (app: App) =>
        Effect.gen(function* () {
          yield* watching(app, "a", attachedInOrder)
          scriptAll(github, [5, 6, 7, 10, 12], stackOf("s", [5, 6, 7, 10, 12]))

          yield* TestClock.adjust("15 seconds")
          yield* app.monitor.poll

          const writes = storage.writes()

          for (let poll = 0; poll < 3; poll += 1) {
            yield* TestClock.adjust("15 seconds")
            yield* app.monitor.poll
          }

          yield* app.monitor.refresh("a")

          return storage.writes() - writes
        }),
      storage,
    )

    expect(result).toEqual(Exit.succeed(0))
  })
})

describe("Monitor Stack order contradictions", () => {
  test("leaves the order alone while two Stacks claim one pull request", async () => {
    const github = beforeLinking()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", attachedInOrder)
        scriptAll(github, [5, 6, 7, 10], stackOf("s", [5, 6, 7, 10, 12]))
        scriptAll(github, [12, 13], stackOf("t", [12, 13]))

        yield* TestClock.adjust("15 seconds")
        yield* app.monitor.poll

        return yield* numbersOf(app)
      }),
    )

    expect(result).toEqual(Exit.succeed([1, 5, 6, 7, 8, 9, 10, 11, 12, 13]))
  })
})
