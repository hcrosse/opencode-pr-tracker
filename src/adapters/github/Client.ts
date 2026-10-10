import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Array as Arr, Effect, Layer, Option, Ref, Result, Schema } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"

import type { PullRequestRef } from "../../domain/PullRequest.ts"
import type { ReviewMode } from "../../domain/Review.ts"
import type { Diagnostic } from "../../domain/Snapshot.ts"
import { charged, failed, GitHub, GitHubFailure, ItemResult } from "../../ports/GitHub.ts"
import { CommandRunner, layer as commandLayer } from "../Command.ts"
import { pullRequestAnswer, type Answer } from "./Answer.ts"
import { contextPages, type ContextNode } from "./Contexts.ts"
import { UnrecognizedLog } from "./Enumeration.ts"
import { GitHubPost, layer as postLayer, type Charge, type PostFailure } from "./Post.ts"
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
import { reviewStates, type ReadReview } from "./Reviews.ts"
import { Suspects } from "./Suspects.ts"
import { layer as tokenLayer, type Token } from "./Token.ts"

interface Item {
  readonly node: PullRequestNode
  readonly review: ReadReview
}

/** The pull request node answered for `key`, with its review state read as `reviews` asks. */
function itemIn(answer: Answer, key: string, reviews: ReviewMode): Result.Result<Item, Diagnostic> {
  const raw = pullRequestAnswer(answer, key)

  if (Result.isFailure(raw)) return Result.fail(raw.failure)

  const node = Schema.decodeUnknownOption(PullRequestNode)(raw.success)
  const review = Schema.decodeUnknownOption(reviewStates[reviews])(raw.success)

  if (Option.isNone(node) || Option.isNone(review)) return Result.fail("InvalidResponse")

  return Result.succeed({ node: node.value, review: review.value })
}

/** Reads a pull request's result from a batch's answer, following its check context pages. */
const itemResults = Effect.fnUntraced(function* (
  reviews: ReviewMode,
  pageSize: number,
  suspects: Suspects,
) {
  const allContexts = yield* contextPages(pageSize)
  const unrecognized = new UnrecognizedLog()

  return Effect.fn("GitHub.itemResult")(function* (
    answer: Answer,
    ref: PullRequestRef,
    key: string,
  ) {
    const item = itemIn(answer, key, reviews)

    if (Result.isFailure(item)) return failed(item.failure)

    const { node, review } = item.success

    return yield* allContexts(ref, node.statusCheckRollup).pipe(
      Effect.tap((contexts: readonly ContextNode[]) =>
        unrecognized.report(ref.url, [...unrecognizedIn(node, contexts), ...review.unrecognized]),
      ),
      Effect.map((contexts: readonly ContextNode[]): ItemResult =>
        ItemResult.Reported({ report: toReport(ref, node, { contexts, review: review.review }) }),
      ),
      Effect.catchTags({
        RequestCharged: ({ charge }: { readonly charge: Charge }) =>
          Effect.sync(() => {
            if (charge === "TimedOut") suspects.timedOut([ref.url])

            return charged
          }),
        RequestFailed: ({ diagnostic }: { readonly diagnostic: Diagnostic }) =>
          Effect.succeed(failed(diagnostic)),
      }),
    )
  })
})

type ItemResultOf = (answer: Answer, ref: PullRequestRef, key: string) => Effect.Effect<ItemResult>

type FetchBatch = (refs: readonly PullRequestRef[]) => Effect.Effect<readonly Entry[], PostFailure>

/** Sends a batch of pull requests in one query and reads each one's result. */
const batchSender = Effect.fnUntraced(function* (
  reviews: ReviewMode,
  pageSize: number,
  itemResult: ItemResultOf,
) {
  const { post } = yield* GitHubPost

  const fetchBatch: FetchBatch = Effect.fn("GitHub.fetchBatch")(function* (
    refs: readonly PullRequestRef[],
  ) {
    const envelope = yield* post(batch(refs.length, reviews, pageSize), batchVariables(refs))
    const aliases = new Set(refs.map((_, index) => alias(index)))

    const results = yield* Effect.forEach(
      refs,
      (ref, index) => itemResult({ aliases, envelope }, ref, alias(index)),
      { concurrency: 4 },
    )

    return Arr.zip(
      refs.map((ref) => ref.url),
      results,
    )
  })

  return fetchBatch
})

const failedAll = (refs: readonly PullRequestRef[], result: ItemResult): Entry[] =>
  refs.map((ref): Entry => [ref.url, result])

const chargedAll = (refs: readonly PullRequestRef[]): BatchOutcome => ({
  entries: failedAll(refs, charged),
  failure: Option.none(),
})

/**
 * A batch's results. A batch that failed as a whole fails each of its pull requests, and counts as
 * a whole failure only when it cost GitHub nothing. A timed-out batch sets the fetch's `stopped`,
 * and once it is set the fetch's remaining batches are not sent.
 */
const batchOutcomes = (
  fetchBatch: FetchBatch,
  suspects: Suspects,
): ((refs: readonly PullRequestRef[], stopped: Ref.Ref<boolean>) => Effect.Effect<BatchOutcome>) =>
  Effect.fn("GitHub.outcomeOf")(function* (
    refs: readonly PullRequestRef[],
    stopped: Ref.Ref<boolean>,
  ): Effect.fn.Return<BatchOutcome> {
    if (yield* Ref.get(stopped)) return chargedAll(refs)

    const stop = Effect.andThen(
      Ref.set(stopped, true),
      Effect.sync(() => {
        suspects.timedOut(refs.map((ref) => ref.url))
      }),
    )

    return yield* fetchBatch(refs).pipe(
      Effect.map((entries: readonly Entry[]): BatchOutcome => {
        suspects.recorded(entries)

        return { entries, failure: Option.none() }
      }),
      Effect.catchTags({
        RequestCharged: ({ charge }: { readonly charge: Charge }) =>
          Effect.as(charge === "TimedOut" ? stop : Effect.void, chargedAll(refs)),
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
      const runner = yield* CommandRunner
      const rateLimit = yield* RateLimit
      const suspects = new Suspects()
      const itemResult = yield* itemResults(reviews, pageSize, suspects)
      const fetchBatch = yield* batchSender(reviews, pageSize, itemResult)
      const outcomeOf = batchOutcomes(fetchBatch, suspects)

      return GitHub.of({
        fetch: Effect.fn("GitHub.fetch")(function* (refs: readonly PullRequestRef[]) {
          const stopped = yield* Ref.make(false)
          const unique = Arr.dedupeWith(refs, (left, right) => left.url === right.url)

          const outcomes = yield* Effect.forEach(
            suspects.batches(unique),
            (refsInBatch: readonly PullRequestRef[]) => outcomeOf(refsInBatch, stopped),
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
