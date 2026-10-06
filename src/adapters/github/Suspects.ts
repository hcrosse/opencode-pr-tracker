import { Array as Arr, Option } from "effect"

import type { PullRequestRef } from "../../domain/PullRequest.ts"
import { maximumBatch } from "../../ports/GitHub.ts"
import type { Entry } from "./Response.ts"

/**
 * Pull requests whose query timed out, oldest first. GitHub may time out on one pull request's
 * query every time, which would fail every batch it joins, so each is sent alone after the others
 * until GitHub answers for it without a charged failure.
 */
export class Suspects {
  private readonly urls = new Set<string>()

  /** `refs` in sending order: batches of the others, then each suspect alone, oldest first. */
  public batches(refs: readonly PullRequestRef[]): PullRequestRef[][] {
    const byUrl = new Map(refs.map((ref) => [ref.url, ref]))

    const suspected = [...this.urls].flatMap((url) =>
      Option.toArray(Option.fromNullishOr(byUrl.get(url))),
    )

    return [
      ...Arr.chunksOf(
        refs.filter((ref) => !this.urls.has(ref.url)),
        maximumBatch,
      ),
      ...suspected.map((ref) => [ref]),
    ]
  }

  /** Suspects `urls`, moving any already suspected to the back so others go first next time. */
  public timedOut(urls: readonly string[]): void {
    for (const url of urls) {
      this.urls.delete(url)
      this.urls.add(url)
    }
  }

  /** Clears the pull requests of an answered request whose result cost GitHub nothing. */
  public recorded(entries: readonly Entry[]): void {
    for (const [url, result] of entries)
      if (result._tag === "Reported" || !result.charged) this.urls.delete(url)
  }
}
