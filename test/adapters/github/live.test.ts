import { describe, expect, test } from "bun:test"

import { Effect, Result } from "effect"

import { live } from "../../../src/adapters/github/Client.ts"
import { parsePullRequestUrl, type PullRequestRef } from "../../../src/domain/PullRequest.ts"
import { GitHub } from "../../../src/ports/GitHub.ts"

const enabled = process.env["GITHUB_LIVE"] === "1"

const tracker = (number: number): PullRequestRef =>
  Result.getOrThrow(
    parsePullRequestUrl(`github.com/hcrosse/opencode-pr-tracker/pull/${String(number)}`),
  )

// Talks to api.github.com with the developer's token. Run with GITHUB_LIVE=1.
describe.skipIf(!enabled)("GitHub client against api.github.com", () => {
  test("reads a merged Stack and a missing pull request", async () => {
    const results = await Effect.runPromise(
      GitHub.use((github) => github.fetch([tracker(78), tracker(79), tracker(999999)])).pipe(
        Effect.provide(live),
      ),
    )

    expect(results.get(tracker(78).url)).toMatchObject({
      _tag: "Reported",
      report: { snapshot: { state: { _tag: "Merged" } } },
    })
    expect(results.get(tracker(999999).url)).toEqual({ _tag: "Failed", diagnostic: "NotFound" })
  })

  test("resolves a number in this checkout's repository", async () => {
    const found = await Effect.runPromise(
      GitHub.use((github) => github.pullRequestInRepository(import.meta.dir, 78)).pipe(
        Effect.provide(live),
      ),
    )

    expect(found.url).toBe(tracker(78).url)
  })
})
