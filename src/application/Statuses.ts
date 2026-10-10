/** What GitHub last reported for each pull request, and the fetches that keep it current. */
import { Effect, Ref } from "effect"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import { GitHub, type ItemResult } from "../ports/GitHub.ts"
import { FetchQueue } from "./FetchQueue.ts"
import { failedEach, recorded, withoutUnattached, type Known } from "./Known.ts"
import { currentMillis } from "./Time.ts"

export interface Statuses {
  /** What GitHub last reported for each pull request, by URL. */
  readonly snapshot: Effect.Effect<ReadonlyMap<string, Known>>
  /**
   * Drops pull requests that no session in use has attached, as of the `before` snapshot. Entries
   * recorded since are kept: they belong to newer attachments.
   */
  readonly prune: (
    before: ReadonlyMap<string, Known>,
    attached: ReadonlyMap<string, PullRequestRef>,
  ) => Effect.Effect<void>
  /** Records GitHub's results for pull requests as of now. */
  readonly remember: (results: ReadonlyMap<string, ItemResult>) => Effect.Effect<void>
  /** Fetches pull requests and records what GitHub said; see `FetchQueue`. */
  readonly fetch: (refs: readonly PullRequestRef[]) => Effect.Effect<void>
}

/** Statuses fetched from GitHub. Fetches run in the scope of whatever builds them. */
export const githubStatuses = Effect.gen(function* () {
  const github = yield* GitHub
  const known = yield* Ref.make<ReadonlyMap<string, Known>>(new Map())

  const remember = Effect.fn("Monitor.remember")(function* (
    results: ReadonlyMap<string, ItemResult>,
  ): Effect.fn.Return<void> {
    const now = yield* currentMillis

    yield* Ref.update(known, (current: ReadonlyMap<string, Known>) =>
      recorded(current, results, now),
    )
  })

  // A failed request counts against each pull request it asked about.
  const update = (refs: readonly PullRequestRef[]): Effect.Effect<void> =>
    github.fetch(refs).pipe(
      Effect.catchTag("GitHubFailure", (failure) => Effect.succeed(failedEach(refs, failure))),
      Effect.flatMap((results: ReadonlyMap<string, ItemResult>) => remember(results)),
    )

  const queue = new FetchQueue(update, yield* Effect.scope)

  const statuses: Statuses = {
    fetch: (refs) => queue.fetch(refs),
    prune: (before, attached) =>
      Ref.update(known, (entries: ReadonlyMap<string, Known>) =>
        withoutUnattached(entries, before, attached),
      ),
    remember,
    snapshot: Ref.get(known),
  }

  return statuses
})
