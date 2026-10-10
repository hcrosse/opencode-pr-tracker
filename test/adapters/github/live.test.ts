import { describe, expect, test } from "bun:test"

import { Effect, Option } from "effect"

import { live } from "../../../src/adapters/github/Client.ts"
import { PullRequestState } from "../../../src/domain/Snapshot.ts"
import { GitHub, ItemResult } from "../../../src/ports/GitHub.ts"
import { memoryStorage } from "../../support/application.ts"
import { trackerRef } from "../../support/github.ts"

// oxlint-disable-next-line node/no-process-env -- The live-test toggle configures describe.skipIf at module load.
const enabled = process.env["GITHUB_LIVE"] === "1"

// Talks to api.github.com with the developer's token. Run with GITHUB_LIVE=1.
describe.skipIf(!enabled)("GitHub client against api.github.com", () => {
  test("reads a merged Stack and a missing pull request", async () => {
    const results = await Effect.runPromise(
      GitHub.use((github) =>
        github.fetch([trackerRef(78), trackerRef(79), trackerRef(999999)]),
      ).pipe(Effect.provide(live(memoryStorage().storage, "all"))),
    )

    const missing = Option.fromNullishOr(results.get(trackerRef(999999).url))

    const merged = Option.flatMap(Option.fromNullishOr(results.get(trackerRef(78).url)), (result) =>
      ItemResult.$match(result, {
        Reported: ({ report }) => Option.some(report.snapshot.state),
        Failed: () => Option.none(),
      }),
    )

    expect(merged).toEqual(Option.some(PullRequestState.cases.Merged.make({})))
    expect(missing).toEqual(
      Option.some(ItemResult.Failed({ charged: false, diagnostic: "NotFound" })),
    )
  })

  test("resolves a number in this checkout's repository", async () => {
    const found = await Effect.runPromise(
      GitHub.use((github) => github.pullRequestInRepository(import.meta.dir, 78)).pipe(
        Effect.provide(live(memoryStorage().storage, "all")),
      ),
    )

    expect(found.url).toBe(trackerRef(78).url)
  })
})
