import { describe, expect, test } from "bun:test"

import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Deferred, Effect, Exit, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"

import { PullRequestInput } from "../../src/domain/PullRequest.ts"
import { requests } from "../../src/server/Requests.ts"
import { memoryStorage, type GitHubScript, type StorageFake } from "../support/application.ts"
import {
  checking,
  fetchedSince,
  open,
  run,
  scripted,
  watching,
  type App,
} from "../support/monitor.ts"

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
  test("does not poll sessions after attaching or showing without a lease", async () => {
    const github = scripted()

    const result = await run(github, (app: App) =>
      Effect.gen(function* () {
        yield* requests(app, { directory: "/work", layout: "full" }).attach("a", checking.url)
        yield* app.tracker.attach("b", PullRequestInput.Reference({ ref: checking }), "/work")
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
        yield* app.tracker.attach("b", PullRequestInput.Reference({ ref: checking }), "/work")
        yield* requests(app, { directory: "/work", layout: "full" }).list("b")

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

interface HoldingStorage {
  readonly fake: StorageFake
  /** Holds the read of `key` that follows the next `skip` reads of it. */
  readonly hold: (key: string, skip: number) => void
  readonly release: (key: string) => Effect.Effect<void>
}

function holdingStorage(): HoldingStorage {
  const base = memoryStorage()
  const gates = new Map<string, Deferred.Deferred<boolean>>()
  const skips = new Map<string, number>()

  const read: StorageDomain["get"] = (key) =>
    Effect.suspend(() => {
      const gate = Option.fromNullishOr(gates.get(key))
      const skip = skips.get(key) ?? 0

      skips.set(key, skip - 1)

      return Option.isSome(gate) && skip <= 0
        ? Effect.andThen(Deferred.await(gate.value), base.storage.get(key))
        : base.storage.get(key)
    })

  const { remove, scan, set } = base.storage

  return {
    fake: { storage: { get: read, remove, scan, set }, values: base.values, writes: base.writes },
    hold: (key, skip) => {
      gates.set(key, Deferred.makeUnsafe<boolean>())
      skips.set(key, skip)
    },
    release: (key) =>
      Effect.suspend(() => {
        const gate = Option.fromNullishOr(gates.get(key))

        gates.delete(key)

        return Effect.asVoid(
          Effect.forEach(Option.toArray(gate), (held) => Deferred.succeed(held, true)),
        )
      }),
  }
}

const settings = { directory: "/work", layout: "full" } as const

describe("Monitor polls racing an agent read", () => {
  test("keeps the statuses of a session an agent listed while a poll was listing", async () => {
    const github = scripted()
    const storage = holdingStorage()

    const result = await run(
      github,
      (app: App) =>
        Effect.gen(function* () {
          yield* requests(app, settings).attach("a", open.url)
          yield* app.monitor.watch("b")

          // The poll waits while listing b. The agent read waits on its second listing of a.
          storage.hold("session/b", 0)
          storage.hold("session/a", 1)

          const poll = yield* Effect.forkChild(app.monitor.poll)
          const read = yield* Effect.forkChild(requests(app, settings).list("a"))

          yield* Effect.yieldNow
          yield* storage.release("session/b")
          yield* Fiber.join(poll)
          yield* storage.release("session/a")

          const view = yield* Fiber.join(read)

          return view.entries.map((entry) => entry.status._tag)
        }),
      storage.fake,
    )

    expect(result).toEqual(Exit.succeed(["Fresh"]))
  })
})
