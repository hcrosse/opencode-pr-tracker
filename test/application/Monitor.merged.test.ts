import { describe, expect, test } from "bun:test"

import { Effect, Exit } from "effect"
import { TestClock } from "effect/testing"

import type { PullRequestRef } from "../../src/domain/PullRequest.ts"
import { agreedStacks, type Membership } from "../../src/domain/StackLayout.ts"
import { reported, ScriptedGitHub, standalone, type GitHubScript } from "../support/application.ts"
import {
  fetchedSince,
  numbersOf,
  ref,
  run,
  scriptAll,
  stackOf,
  watching,
  type App,
} from "../support/monitor.ts"

/** #5 merged at the bottom of Stack #5, #6, #7; #8 and #10 standalone, attached after it. */
function mergedBottom(): ScriptedGitHub {
  const github = new ScriptedGitHub()
  const stack = stackOf("s", [5, 6, 7])

  github.script(ref(5), reported(ref(5), { _tag: "Merged" }, stack))
  scriptAll(github, [6, 7], stack)
  scriptAll(github, [8, 10], standalone)

  return github
}

/** Links #10 onto the Stack; `mergedReport` is what GitHub then says about merged #5. */
function linkTen(github: Readonly<GitHubScript>, mergedReport: Membership): void {
  scriptAll(github, [6, 7, 10], stackOf("s", [5, 6, 7, 10]))
  github.script(ref(5), reported(ref(5), { _tag: "Merged" }, mergedReport))
}

/** Takes #7 out of the Stack; merged #5 then reports the Stack without it. */
function unlinkSeven(github: Readonly<GitHubScript>): void {
  const remaining = stackOf("s", [5, 6])

  scriptAll(github, [6], remaining)
  scriptAll(github, [7], standalone)
  github.script(ref(5), reported(ref(5), { _tag: "Merged" }, remaining))
}

const refs = (numbers: readonly number[]): PullRequestRef[] => numbers.map((number) => ref(number))

const pollAfter = (app: App): Effect.Effect<void> =>
  Effect.andThen(TestClock.adjust("15 seconds"), app.monitor.poll)

describe("Monitor Stack order with a merged member", () => {
  test("asks about a merged member again once a linked Stack contradicts it, then groups", async () => {
    const github = mergedBottom()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", refs([5, 8, 10]))
        yield* app.monitor.poll
        linkTen(github, stackOf("s", [5, 6, 7, 10]))

        const before = github.fetches.length

        for (let poll = 0; poll < 3; poll += 1) yield* pollAfter(app)

        return { fetched: fetchedSince(github, before), order: yield* numbersOf(app) }
      }),
    )

    expect(result).toEqual(
      Exit.succeed({
        fetched: [
          [6, 7, 8, 10],
          [5, 6, 7, 8, 10],
          [6, 7, 10, 8],
        ],
        order: [5, 6, 7, 10, 8],
      }),
    )
  })
})

describe("Monitor Stack order with a lasting contradiction", () => {
  test("asks about the merged member only once while GitHub keeps contradicting itself", async () => {
    const github = mergedBottom()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", refs([5, 8, 10]))
        yield* app.monitor.poll
        linkTen(github, stackOf("s", [5, 6, 7]))

        const before = github.fetches.length

        for (let poll = 0; poll < 4; poll += 1) yield* pollAfter(app)

        return fetchedSince(github, before).filter((numbers: readonly number[]) =>
          numbers.includes(5),
        ).length
      }),
    )

    expect(result).toEqual(Exit.succeed(1))
  })
})

describe("Monitor Stack order after unlinking", () => {
  test("asks about a merged member again once a pull request leaves its Stack, then draws it", async () => {
    const github = mergedBottom()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", refs([5, 8]))
        yield* app.monitor.poll

        unlinkSeven(github)

        const before = github.fetches.length

        yield* pollAfter(app)
        yield* pollAfter(app)

        const { entries } = yield* app.monitor.view("a")
        const stacks = agreedStacks(entries).map((agreed) => agreed.members.map((m) => m.number))

        return { fetched: fetchedSince(github, before), stacks }
      }),
    )

    expect(result).toEqual(
      Exit.succeed({
        fetched: [
          [6, 7, 8],
          [5, 6, 7, 8],
        ],
        stacks: [[5, 6]],
      }),
    )
  })
})
