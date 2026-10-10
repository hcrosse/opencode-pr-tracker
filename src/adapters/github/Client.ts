import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Array as Arr, Effect, Layer, Option, Ref, Result, Schema } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"

import type { PullRequestRef } from "../../domain/PullRequest.ts"
import type { ReviewMode } from "../../domain/Review.ts"
import type { Diagnostic } from "../../domain/Snapshot.ts"
import { charged, failed, GitHub, GitHubFailure, ItemResult } from "../../ports/GitHub.ts"
import { CommandRunner, layer as commandLayer } from "../Command.ts"
import { pullRequestAnswer, type Answer } from "./Answer.ts"
import { allContexts, type Asking, type ContextNode } from "./Contexts.ts"
import { UnrecognizedLog } from "./Enumeration.ts"
import { GitHubPost, layer as postLayer, type Charge } from "./Post.ts"
import { alias, batch, batchVariables, defaultPageSize } from "./Query.ts"
import { RateLimit, layer as rateLimitLayer } from "./RateLimit.ts"
import { resolveInRepository } from "./Repository.ts"
import {
  combined,
  PullRequestNode,
  toReport,
  unrecognizedIn,
  type BatchOutcome,
  type Entry,
} from "./Response.ts"
import { reviewStates } from "./Reviews.ts"
import { Suspects } from "./Suspects.ts"
import { layer as tokenLayer, type Token } from "./Token.ts"

interface Batch extends Answer, Asking {
  readonly reviews: ReviewMode
  readonly suspects: Suspects
  readonly unrecognized: UnrecognizedLog
}

const itemResult = Effect.fn("GitHub.itemResult")(function* (
  request: Batch,
  ref: PullRequestRef,
  key: string,
) {
  const raw = pullRequestAnswer(request, key)

  if (Result.isFailure(raw)) return failed(raw.failure)

  const node = Schema.decodeUnknownOption(PullRequestNode)(raw.success)
  const review = Schema.decodeUnknownOption(reviewStates[request.reviews])(raw.success)

  if (Option.isNone(node) || Option.isNone(review)) return failed("InvalidResponse")

  return yield* allContexts(request, ref, node.value.statusCheckRollup).pipe(
    Effect.tap((contexts: readonly ContextNode[]) =>
      request.unrecognized.report(ref.url, [
        ...unrecognizedIn(node.value, contexts),
        ...review.value.unrecognized,
      ]),
    ),
    Effect.map((contexts: readonly ContextNode[]): ItemResult =>
      ItemResult.Reported({
        report: toReport(ref, node.value, { contexts, review: review.value.review }),
      }),
    ),
    Effect.catchTags({
      RequestCharged: ({ charge }: { readonly charge: Charge }) =>
        Effect.sync(() => {
          if (charge === "TimedOut") request.suspects.timedOut([ref.url])

          return charged
        }),
      RequestFailed: ({ diagnostic }: { readonly diagnostic: Diagnostic }) =>
        Effect.succeed(failed(diagnostic)),
    }),
  )
})

const fetchBatch = Effect.fn("GitHub.fetchBatch")(function* (
  sending: Sending,
  refs: readonly PullRequestRef[],
) {
  const { pageSize, post, reviews, suspects, unrecognized } = sending
  const envelope = yield* post(batch(refs.length, reviews, pageSize), batchVariables(refs))
  const aliases = new Set(refs.map((_, index) => alias(index)))

  const results = yield* Effect.forEach(
    refs,
    (ref, index) =>
      itemResult(
        { aliases, envelope, pageSize, post, reviews, suspects, unrecognized },
        ref,
        alias(index),
      ),
    {
      concurrency: 4,
    },
  )

  return Arr.zip(
    refs.map((ref) => ref.url),
    results,
  )
})

interface Sending extends Asking {
  readonly reviews: ReviewMode
  readonly suspects: Suspects
  readonly unrecognized: UnrecognizedLog
  /** Set once a batch times out: the fetch's remaining batches are not sent. */
  readonly stopped: Ref.Ref<boolean>
}

const failedAll = (refs: readonly PullRequestRef[], result: ItemResult): Entry[] =>
  refs.map((ref): Entry => [ref.url, result])

/**
 * A batch's results. A batch that failed as a whole fails each of its pull requests, and counts as
 * a whole failure only when it cost GitHub nothing. A timed-out batch stops the fetch.
 */
const outcomeOf = Effect.fn("GitHub.outcomeOf")(function* (
  sending: Sending,
  refs: readonly PullRequestRef[],
): Effect.fn.Return<BatchOutcome> {
  if (yield* Ref.get(sending.stopped))
    return { entries: failedAll(refs, charged), failure: Option.none() }

  const stop = Effect.andThen(
    Ref.set(sending.stopped, true),
    Effect.sync(() => {
      sending.suspects.timedOut(refs.map((ref) => ref.url))
    }),
  )

  return yield* fetchBatch(sending, refs).pipe(
    Effect.map((entries: readonly Entry[]): BatchOutcome => {
      sending.suspects.recorded(entries)

      return { entries, failure: Option.none() }
    }),
    Effect.catchTags({
      RequestCharged: ({ charge }: { readonly charge: Charge }) =>
        Effect.as(charge === "TimedOut" ? stop : Effect.void, {
          entries: failedAll(refs, charged),
          failure: Option.none(),
        }),
      RequestFailed: ({ diagnostic }: { readonly diagnostic: Diagnostic }) =>
        Effect.succeed({
          entries: failedAll(refs, failed(diagnostic)),
          failure: Option.some(diagnostic),
        }),
    }),
  )
})

/** What the GitHub port requires: an HTTP client, a token source, a rate limit, and `gh`. */
type Requirements = HttpClient.HttpClient | Token | RateLimit | CommandRunner

/** The GitHub port over GraphQL, fetching the review state `reviews` asks for. */
export const layer = (
  reviews: ReviewMode,
  pageSize = defaultPageSize,
): Layer.Layer<GitHub, never, Requirements> =>
  Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const { post } = yield* GitHubPost
      const runner = yield* CommandRunner
      const rateLimit = yield* RateLimit
      const suspects = new Suspects()
      const unrecognized = new UnrecognizedLog()

      return GitHub.of({
        fetch: Effect.fn("GitHub.fetch")(function* (refs: readonly PullRequestRef[]) {
          const stopped = yield* Ref.make(false)
          const sending: Sending = { pageSize, post, reviews, stopped, suspects, unrecognized }
          const unique = Arr.dedupeWith(refs, (left, right) => left.url === right.url)

          const outcomes = yield* Effect.forEach(
            suspects.batches(unique),
            (refsInBatch: readonly PullRequestRef[]) => outcomeOf(sending, refsInBatch),
          )

          return yield* Effect.fromResult(combined(outcomes)).pipe(
            Effect.mapError((diagnostic: Diagnostic) => new GitHubFailure({ diagnostic })),
          )
        }),
        // `gh repo view` queries GitHub, so it waits out a rate limit too.
        pullRequestInRepository: (directory, number) =>
          Effect.andThen(
            rateLimit.check,
            resolveInRepository(directory, number).pipe(
              Effect.provideService(CommandRunner, runner),
            ),
          ),
      })
    }),
  ).pipe(Layer.provide(postLayer))

/**
 * The GitHub port over `api.github.com`, with tokens from the environment or `gh`, and rate-limit
 * waits kept in plugin storage.
 */
export const live = (storage: StorageDomain, reviews: ReviewMode): Layer.Layer<GitHub> =>
  layer(reviews).pipe(
    Layer.provide([tokenLayer, rateLimitLayer(storage)]),
    Layer.provide([commandLayer, FetchHttpClient.layer]),
  )
