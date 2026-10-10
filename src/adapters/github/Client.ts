import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Array as Arr, Effect, Layer, Option, Ref, Result, Schema } from "effect"
import { FetchHttpClient, type HttpClient } from "effect/unstable/http"

import type { PullRequestRef } from "../../domain/PullRequest.ts"
import type { ReviewMode } from "../../domain/Review.ts"
import type { Diagnostic } from "../../domain/Snapshot.ts"
import { GitHub, GitHubFailure, type ItemResult } from "../../ports/GitHub.ts"
import { CommandRunner, layer as commandLayer } from "../Command.ts"
import { failure, makePost, type Envelope, type Post, type RequestFailed } from "./Post.ts"
import { alias, batch, continuation } from "./Query.ts"
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
import { reviewReaders } from "./Reviews.ts"
import { Suspects } from "./Suspects.ts"
import { layer as tokenLayer, type Token } from "./Token.ts"

const ContinuationData = Schema.Struct({
  resource: Schema.Struct({ statusCheckRollup: Schema.Struct({ contexts: Contexts }) }),
})

const failed = (diagnostic: Diagnostic, charged: boolean): ItemResult => ({
  _tag: "Failed",
  charged,
  diagnostic,
})

const failedBy = (requestFailure: RequestFailed): ItemResult =>
  failed(requestFailure.diagnostic, requestFailure.cost !== "Free")

/** Every check context for a pull request, following continuation pages. */
const allContexts = Effect.fn("allContexts")(function* (post: Post, node: PullRequestNode) {
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

    const envelope = yield* post(continuation(), { cursor: after, url: node.url })

    if ((envelope.errors ?? []).length > 0) return yield* failure("InvalidResponse", "Free")

    const data = yield* Schema.decodeUnknownEffect(ContinuationData)(envelope.data).pipe(
      Effect.mapError(() => failure("InvalidResponse", "Free")),
    )

    page = Option.some(data.resource.statusCheckRollup.contexts)
  }

  return collected
})

/** GraphQL error types meaning the pull request does not exist or this token cannot see it. */
const inaccessible = new Set(["NOT_FOUND", "FORBIDDEN"])

/** Errors for `key`, or naming no alias, fail it; only its own inaccessible errors mean missing. */
function aliasFailure(request: Batch, key: string): Option.Option<Diagnostic> {
  const diagnostics = (request.envelope.errors ?? []).flatMap((error): Diagnostic[] => {
    const root = String((error.path ?? [])[0] ?? "")

    if (root === key) return [inaccessible.has(error.type ?? "") ? "NotFound" : "InvalidResponse"]

    return request.aliases.has(root) ? [] : ["InvalidResponse"]
  })

  if (diagnostics.length === 0) return Option.none()

  return Option.some(diagnostics.includes("InvalidResponse") ? "InvalidResponse" : "NotFound")
}

interface Batch {
  readonly reviews: ReviewMode
  readonly post: Post
  readonly suspects: Suspects
  readonly envelope: Envelope
  /** The aliases of this batch's pull requests. */
  readonly aliases: ReadonlySet<string>
}

const itemResult = Effect.fn("itemResult")(function* (
  request: Batch,
  ref: PullRequestRef,
  key: string,
) {
  const { envelope, post } = request
  const reported = aliasFailure(request, key)
  const raw = Option.fromNullishOr((envelope.data ?? {})[key])

  if (Option.isSome(reported)) return failed(reported.value, false)

  if (Option.isNone(raw)) return failed("NotFound", false)

  const node = Schema.decodeUnknownOption(PullRequestNode)(raw.value)

  if (Option.isNone(node)) return failed("InvalidResponse", false)

  const review = reviewReaders[request.reviews](node.value)

  if (Option.isNone(review)) return failed("InvalidResponse", false)

  const contexts = yield* Effect.result(allContexts(post, node.value))

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
  const { post, reviews, suspects } = sending
  const variables = Object.fromEntries(refs.map((ref, index) => [alias(index), ref.url]))
  const envelope = yield* post(batch(refs.length, reviews), variables)
  const aliases = new Set(Object.keys(variables))

  const results = yield* Effect.forEach(
    refs,
    (ref, index) => itemResult({ aliases, envelope, post, reviews, suspects }, ref, alias(index)),
    {
      concurrency: 4,
    },
  )

  return Arr.zip(
    refs.map((ref) => ref.url),
    results,
  )
})

interface Sending {
  readonly reviews: ReviewMode
  readonly post: Post
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
export const layer = (reviews: ReviewMode): Layer.Layer<GitHub, never, Requirements> =>
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
            const sending: Sending = { post, reviews, stopped: yield* Ref.make(false), suspects }
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
