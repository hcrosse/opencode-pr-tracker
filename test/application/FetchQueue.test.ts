import { describe, expect, test } from "bun:test"

import { Effect, Exit } from "effect"

import { FetchQueue } from "../../src/application/FetchQueue.ts"
import { open } from "../support/monitor.ts"

describe("FetchQueue failures", () => {
  test("fails the waiting request when a fetch dies, and fetches normally afterwards", async () => {
    let calls = 0

    const fetchNow = (): Effect.Effect<void> =>
      Effect.suspend(() => {
        calls += 1

        return calls === 1 ? Effect.die("broken fetch") : Effect.void
      })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const queue = new FetchQueue(fetchNow, yield* Effect.scope)
        const first = yield* Effect.exit(queue.fetch([open]))
        const second = yield* Effect.exit(queue.fetch([open]))

        return [Exit.isFailure(first), Exit.isSuccess(second)]
      }).pipe(Effect.scoped, Effect.timeout("1 second"), Effect.exit),
    )

    expect(result).toEqual(Exit.succeed([true, true]))
  })
})
