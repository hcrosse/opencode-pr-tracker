import { describe, expect, test } from "bun:test"

import { Effect, Exit } from "effect"

import type { TrackerApi } from "../../src/application/Tracker.ts"
import type { PullRequestRef } from "../../src/domain/PullRequest.ts"
import { byUrl, numbers, ref, refs, run, world } from "../support/tracker.ts"

const attachAll = (tracker: TrackerApi, values: readonly number[]): Effect.Effect<void, unknown> =>
  Effect.forEach(
    refs(values),
    (pullRequest: PullRequestRef) => tracker.attach("session", byUrl(pullRequest), "/work"),
    { discard: true },
  )

describe("Tracker regroup", () => {
  test("stores a Stack's attached members together, and saves nothing once they are", async () => {
    const setup = world()
    const stack = refs([5, 6, 9])

    const result = await run(setup, (tracker: TrackerApi) =>
      Effect.gen(function* () {
        yield* attachAll(tracker, [1, 5, 8, 6, 9])

        const regrouped = numbers(yield* tracker.regroup("session", [stack]))
        const writes = setup.storage.writes()

        yield* tracker.regroup("session", [stack])

        const stored = numbers(yield* tracker.list("session"))

        return { again: setup.storage.writes() - writes, regrouped, stored }
      }),
    )

    expect(result).toEqual(
      Exit.succeed({ again: 0, regrouped: [1, 5, 6, 9, 8], stored: [1, 5, 6, 9, 8] }),
    )
  })
})

describe("Tracker regroup concurrency", () => {
  test("keeps a detach requested at the same time", async () => {
    const result = await run(world(), (tracker: TrackerApi) =>
      Effect.gen(function* () {
        yield* attachAll(tracker, [5, 8, 6])

        yield* Effect.all(
          [tracker.regroup("session", [refs([5, 6])]), tracker.detach("session", byUrl(ref(8)))],
          { concurrency: "unbounded" },
        )

        return numbers(yield* tracker.list("session"))
      }),
    )

    expect(result).toEqual(Exit.succeed([5, 6]))
  })
})
