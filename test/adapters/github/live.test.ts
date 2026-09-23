import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import { live } from "../../../src/adapters/github/Client.ts"
import { GitHub } from "../../../src/ports/GitHub.ts"
import { trackerRef } from "../../support/github.ts"

const enabled = process.env["GITHUB_LIVE"] === "1"

// Talks to api.github.com with the developer's token. Run with GITHUB_LIVE=1.
describe.skipIf(!enabled)("GitHub client against api.github.com", () => {
  test("reads a merged Stack and a missing pull request", async () => {
    const results = await Effect.runPromise(
      GitHub.use((github) =>
        github.fetch([trackerRef(78), trackerRef(79), trackerRef(999999)]),
      ).pipe(Effect.provide(live)),
    )

    expect(results.get(trackerRef(78).url)).toMatchObject({
      _tag: "Reported",
      report: { snapshot: { state: { _tag: "Merged" } } },
    })
    expect(results.get(trackerRef(999999).url)).toEqual({ _tag: "Failed", diagnostic: "NotFound" })
  })

  test("resolves a number in this checkout's repository", async () => {
    const found = await Effect.runPromise(
      GitHub.use((github) => github.pullRequestInRepository(import.meta.dir, 78)).pipe(
        Effect.provide(live),
      ),
    )

    expect(found.url).toBe(trackerRef(78).url)
  })
})
