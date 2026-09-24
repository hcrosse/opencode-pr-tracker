import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { type Cause, Deferred, Effect, Exit, Fiber } from "effect"

import { SessionLocks } from "../../src/application/SessionLocks.ts"

async function settle<A, E>(
  effect: Effect.Effect<A, E>,
): Promise<Exit.Exit<A, E | Cause.TimeoutError>> {
  const result = await Effect.runPromise(Effect.exit(effect.pipe(Effect.timeout("1 second"))))

  return result
}

const yieldTimes = (times: number): Effect.Effect<void> =>
  Effect.forEach(Array.from({ length: times }), () => Effect.yieldNow, { discard: true })

interface Operation {
  readonly session: string
  /** How long the operation waits before asking for the lock. */
  readonly arrives: number
  readonly runs: number
}

const operations = gs.arrays(
  gs.composite((tc): Operation => ({
    arrives: tc.draw(gs.integers({ maxValue: 6, minValue: 0 })),
    runs: tc.draw(gs.integers({ maxValue: 3, minValue: 0 })),
    session: tc.draw(gs.sampledFrom(["a", "b", "c"])),
  })),
  { maxSize: 12 },
)

describe("SessionLocks under concurrent operations", () => {
  test("never overlap one session's operations, and hold nothing once they finish", async () => {
    await hegel.testAsync(async (tc) => {
      const locks = new SessionLocks()
      const running = new Set<string>()
      const overlaps: string[] = []

      const operation = ({ arrives, runs, session }: Operation): Effect.Effect<void> =>
        Effect.andThen(
          yieldTimes(arrives),
          locks.run(
            session,
            Effect.gen(function* () {
              if (running.has(session)) overlaps.push(session)

              running.add(session)
              yield* yieldTimes(runs)
              running.delete(session)
            }),
          ),
        )

      const result = await settle(
        Effect.forEach(tc.draw(operations), operation, { concurrency: "unbounded", discard: true }),
      )

      expect({ held: locks.held, overlaps, result }).toEqual({
        held: 0,
        overlaps: [],
        result: Exit.void,
      })
    })
  })
})

describe("SessionLocks release", () => {
  test("hold nothing after an operation fails", async () => {
    const locks = new SessionLocks()

    const result = await settle(locks.run("session", Effect.fail("broken")))

    expect(result).toEqual(Exit.fail("broken"))
    expect(locks.held).toBe(0)
  })

  test("keep a session's lock while an operation waits, and release it when the waiter is interrupted", async () => {
    const locks = new SessionLocks()

    const result = await settle(
      Effect.gen(function* () {
        const release = yield* Deferred.make<boolean>()
        const running = yield* Effect.forkChild(locks.run("session", Deferred.await(release)))

        yield* Effect.yieldNow

        const waiting = yield* Effect.forkChild(locks.run("session", Effect.void))

        yield* Effect.yieldNow

        const whileBusy = locks.held

        yield* Fiber.interrupt(waiting)
        yield* Deferred.succeed(release, true)
        yield* Fiber.join(running)

        return { after: locks.held, whileBusy }
      }),
    )

    expect(result).toEqual(Exit.succeed({ after: 0, whileBusy: 1 }))
  })
})
