import { Effect, Exit, Layer, Option } from "effect"
import { describe, expect, test } from "vitest"

import { layer as storageLayer } from "../../src/adapters/Storage.ts"
import {
  PullRequestUnavailable,
  Tracker,
  layer as trackerLayer,
} from "../../src/application/Tracker.ts"
import { PullRequestInput } from "../../src/domain/PullRequest.ts"
import { GitHub, GitHubFailure } from "../../src/ports/GitHub.ts"
import { memoryStorage } from "../support/application.ts"
import { ref } from "../support/tracker.ts"

/** A GitHub port whose fetch answers for none of the pull requests it is asked about. */
const silentGitHub = Layer.succeed(
  GitHub,
  GitHub.of({
    fetch: () => Effect.succeed(new Map()),
    pullRequestInRepository: () => Effect.fail(new GitHubFailure({ diagnostic: "NotFound" })),
  }),
)

describe("Tracker attach with an incomplete answer", () => {
  test("reports a pull request GitHub's answer leaves out as an invalid response", async () => {
    const layer = trackerLayer.pipe(
      Layer.provide([silentGitHub, storageLayer(memoryStorage().storage)]),
    )

    const result = await Effect.runPromise(
      Effect.exit(
        Tracker.use((tracker) =>
          tracker.attach("session", PullRequestInput.Reference({ ref: ref(1) }), "/work"),
        ).pipe(Effect.provide(layer)),
      ),
    )

    const rejection = Option.filter(
      Exit.findErrorOption(result),
      (error: unknown): error is PullRequestUnavailable => error instanceof PullRequestUnavailable,
    )

    expect(Option.map(rejection, (found) => [found.diagnostic, found.url])).toEqual(
      Option.some(["InvalidResponse", ref(1).url]),
    )
  })
})
