import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Array as Arr, Effect, Layer, Option, Ref, Result, Schema } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"

import type { PullRequestRef } from "../../domain/PullRequest.ts"
import type { ReviewMode } from "../../domain/Review.ts"
import type { Diagnostic } from "../../domain/Snapshot.ts"
import { GitHub, GitHubFailure, type ItemResult } from "../../ports/GitHub.ts"
import { CommandRunner, layer as commandLayer } from "../Command.ts"
import { pullRequestAnswer, type Answer } from "./Answer.ts"
import { failure, makePost, type Post, type RequestFailed } from "./Post.ts"
import {
  alias,
  batch,
  batchVariables,
  continuation,
  continuationVariables,
  defaultPageSize,
} from "./Query.ts"
import { RateLimit, layer as rateLimitLayer } from "./RateLimit.ts"
import { resolveInRepository } from "./Repository.ts"
import {
  combined,
  Contexts,
  PullRequestNode,
  toReport,
  type BatchOutcome,
  type ContextNode,
  type Entry,
} from "./Response.ts"
import { reviewStates } from "./Reviews.ts"
import { Suspects } from "./Suspects.ts"
import { layer as tokenLayer, type Token } from "./Token.ts"

const ContinuationData = Schema.Struct({
  repository: Schema.Struct({
    pullRequest: Schema.Struct({ statusCheckRollup: Schema.Struct({ contexts: Contexts }) }),
  }),
})

const failed = (diagnostic: Diagnostic, charged: boolean): ItemResult => ({
  _tag: "Failed",
  charged,
  diagnostic,
})

const failedBy = (requestFailure: RequestFailed): ItemResult =>
  failed(requestFailure.diagnostic, requestFailure.cost !== "Free")

/** How the client asks GitHub: by posting queries, for `pageSize` check contexts a page. */
interface Asking {
  readonly post: Post
  readonly pageSize: number
}

/** Every check context for a pull request, following continuation pages. */
const allContexts = Effect.fn("allContexts")(function* (
  { pageSize, post }: Asking,
  ref: PullRequestRef,
  node: PullRequestNode,
) {
  const collected: ContextNode[] = []
  const followed = new Set<string>()
  let page = Option.map(Option.fromNullishOr(node.statusCheckRollup), (rollup) => rollup.contexts)

  while (Option.isSome(page)) {
    collected.push(...page.value.nodes)

    if (!page.value.pageInfo.hasNextPage) break

    // A claimed next page needs a new cursor, or CI would be judged on part or paging never end.
    const after = page.value.pageInfo.endCursor ?? ""

    if (after === "" || followed.has(after)) return yield* failure("InvalidResponse", "Free")

    followed.add(after)

    const envelope = yield* post(continuation(pageSize), continuationVariables(ref, after))

    if ((envelope.errors ?? []).length > 0) return yield* failure("InvalidResponse", "Free")

    const data = yield* Schema.decodeUnknownEffect(ContinuationData)(envelope.data).pipe(
      Effect.mapError(() => failure("InvalidResponse", "Free")),
    )

    page = Option.some(data.repository.pullRequest.statusCheckRollup.contexts)
  }

  return collected
})

interface Batch extends Answer, Asking {
  readonly reviews: ReviewMode
  readonly suspects: Suspects
}

const itemResult = Effect.fn("itemResult")(function* (
  request: Batch,
  ref: PullRequestRef,
  key: string,
) {
  const raw = pullRequestAnswer(request, key)

  if (Result.isFailure(raw)) return failed(raw.failure, false)

  const node = Schema.decodeUnknownOption(PullRequestNode)(raw.success)

  if (Option.isNone(node)) return failed("InvalidResponse", false)

  const review = Schema.decodeUnknownOption(reviewStates[request.reviews])(raw.success)

  if (Option.isNone(review)) return failed("InvalidResponse", false)

  const contexts = yield* Effect.result(allContexts(request, ref, node.value))

  if (Result.isFailure(contexts)) {
    if (contexts.failure.cost === "TimedOut") request.suspects.timedOut([ref.url])

    return failedBy(contexts.failure)
  }

  return {
    _tag: "Reported",
    report: toReport(ref, node.value, { contexts: contexts.success, review: review.value }),
  } satisfies ItemResult
})

const fetchBatch = Effect.fn("fetchBatch")(function* (
  sending: Sending,
  refs: readonly PullRequestRef[],
) {
  const { pageSize, post, reviews, suspects } = sending
  const envelope = yield* post(batch(refs.length, reviews, pageSize), batchVariables(refs))
  const aliases = new Set(refs.map((_, index) => alias(index)))

  const results = yield* Effect.forEach(
    refs,
    (ref, index) =>
      itemResult({ aliases, envelope, pageSize, post, reviews, suspects }, ref, alias(index)),
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
  /** Set once a batch times out: the fetch's remaining batches are not sent. */
  readonly stopped: Ref.Ref<boolean>
}

const failedAll = (refs: readonly PullRequestRef[], result: ItemResult): Entry[] =>
  refs.map((ref): Entry => [ref.url, result])

/**
 * A batch's results. A batch that failed as a whole fails each of its pull requests, and counts as
 * a whole failure only when it cost GitHub nothing. A timed-out batch stops the fetch.
 */
const outcomeOf = (
  sending: Sending,
  refs: readonly PullRequestRef[],
): Effect.Effect<BatchOutcome> =>
  Effect.gen(function* () {
    if (yield* Ref.get(sending.stopped))
      return { entries: failedAll(refs, failed("GitHubUnavailable", true)), failure: Option.none() }

    const result = yield* Effect.result(fetchBatch(sending, refs))

    if (Result.isSuccess(result)) {
      sending.suspects.recorded(result.success)

      return { entries: result.success, failure: Option.none() }
    }

    const { cost, diagnostic } = result.failure

    if (cost === "TimedOut") {
      yield* Ref.set(sending.stopped, true)
      sending.suspects.timedOut(refs.map((ref) => ref.url))
    }

    return {
      entries: failedAll(refs, failedBy(result.failure)),
      failure: cost === "Free" ? Option.some(diagnostic) : Option.none(),
    }
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
      const post = yield* makePost()
      const runner = yield* CommandRunner
      const rateLimit = yield* RateLimit
      const suspects = new Suspects()

      return GitHub.of({
        fetch: (refs) =>
          Effect.gen(function* () {
            const stopped = yield* Ref.make(false)
            const sending: Sending = { pageSize, post, reviews, stopped, suspects }
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
  )

/**
 * The GitHub port over `api.github.com`, with tokens from the environment or `gh`, and rate-limit
 * waits kept in plugin storage.
 */
export const live = (storage: StorageDomain, reviews: ReviewMode): Layer.Layer<GitHub> =>
  layer(reviews).pipe(
    Layer.provide([tokenLayer, rateLimitLayer(storage)]),
    Layer.provide([commandLayer, FetchHttpClient.layer]),
  )
