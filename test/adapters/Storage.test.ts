import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Effect, Exit, Option, Result, type Schema } from "effect"

import { layer } from "../../src/adapters/Storage.ts"
import { attach, maximumAttachments, type Tracking } from "../../src/domain/Tracking.ts"
import {
  TrackingRepository,
  type TrackingRepositoryApi,
} from "../../src/ports/TrackingRepository.ts"
import { memoryStorage, type StorageFake } from "../support/application.ts"
import { pullRequestRefs } from "../support/generators.ts"

async function run<A, E>(
  fake: StorageFake,
  use: (repository: TrackingRepositoryApi) => Effect.Effect<A, E>,
): Promise<Exit.Exit<A, E>> {
  const result = await Effect.runPromise(
    Effect.exit(TrackingRepository.use(use).pipe(Effect.provide(layer(fake.storage)))),
  )

  return result
}

const trackings = gs.composite((tc): Tracking => {
  let tracking: Tracking = []

  for (const [time, ref] of tc
    .draw(gs.arrays(pullRequestRefs, { maxSize: maximumAttachments }))
    .entries()) {
    const next = attach(tracking, [ref], time * 1000)

    if (Result.isSuccess(next)) tracking = next.success.tracking
  }

  return tracking
})

describe("Stored attachments", () => {
  test("load back exactly as saved", async () => {
    await hegel.testAsync(async (tc) => {
      const tracking = tc.draw(trackings)
      const fake = memoryStorage()

      const loaded = await run(fake, (repository: TrackingRepositoryApi) =>
        Effect.andThen(repository.save("session", tracking), repository.load("session")),
      )

      expect(loaded).toEqual(Exit.succeed(tracking))
    })
  })

  test("are empty for a session with nothing stored", async () => {
    expect(
      await run(memoryStorage(), (repository: TrackingRepositoryApi) => repository.load("new")),
    ).toEqual(Exit.succeed([]))
  })
})

describe("Stored attachments that are invalid", () => {
  const url = "https://github.com/acme/api/pull/1"

  test.each<readonly [string, Schema.Json]>([
    ["an unknown version", { pullRequests: [], version: 2 }],
    [
      "a URL that is not a pull request",
      { pullRequests: [{ attachedAt: 0, url: "https://example.com" }], version: 1 },
    ],
    [
      "a duplicate",
      {
        pullRequests: [
          { attachedAt: 0, url },
          { attachedAt: 1, url },
        ],
        version: 1,
      },
    ],
    ["something that is not attachments", "hello"],
  ])("report %s as invalid and leave it in place", async (_name, stored) => {
    const fake = memoryStorage()

    await Effect.runPromise(fake.storage.set("session/session", stored))

    const result = await run(fake, (repository: TrackingRepositoryApi) =>
      repository.load("session"),
    )

    expect(Exit.findErrorOption(result)).toMatchObject(
      Option.some({ _tag: "StoredStateInvalid", sessionID: "session" }),
    )
    expect(fake.values.get("session/session")).toEqual(stored)
  })
})
