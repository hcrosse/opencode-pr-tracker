import { Exit, Option, type Schema } from "effect"

import type { Review, ReviewMode } from "../../src/domain/Review.ts"
import type { ItemResult } from "../../src/ports/GitHub.ts"
import { httpClient, recordedNode, runClient, tracker127 } from "./github.ts"

/** The commit at the head of #127 in the responses below. */
export const head = "5248a25"

/** Review fields to replace in the recorded #127 response; a field set to null is kept as null. */
export interface ReviewFields {
  readonly reviewDecision?: string | null
  readonly author?: { readonly login: string } | null
  readonly latestOpinionatedReviews?: Schema.Json
  readonly reviewThreads?: Schema.Json
}

export interface Fetched {
  /** The query the client sent. */
  readonly query: string
  readonly result: Option.Option<ItemResult>
}

/** What the client reports for #127 when GitHub answers with the recorded node and `fields`. */
export async function fetch127(fields: ReviewFields, reviews: ReviewMode): Promise<Fetched> {
  const node = Object.assign({}, recordedNode("standalone", "pr0"), { headRefOid: head }, fields)
  const http = httpClient(() => Response.json({ data: { pr0: node } }))
  const exit = await runClient({ http, reviews }, (github) => github.fetch([tracker127]))

  return {
    query: http.requests.map((request) => request.query).join("\n"),
    result: Option.flatMap(Exit.getSuccess(exit), (results) =>
      Option.fromNullishOr(results.get(tracker127.url)),
    ),
  }
}

export const reviewOfResult = (result: Option.Option<ItemResult>): Option.Option<Review> =>
  Option.flatMap(result, (item) => {
    if (item._tag !== "Reported") return Option.none()

    const { state } = item.report.snapshot

    return state._tag === "Open" ? Option.some(state.review) : Option.none()
  })

/** The review state the client reports for #127 with review state on. */
export async function reviewFrom(fields: ReviewFields): Promise<Option.Option<Review>> {
  const { result } = await fetch127(fields, "all")

  return reviewOfResult(result)
}
