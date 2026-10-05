import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Array as Arr, Effect, Layer, Option, Result, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

import type { PullRequestRef } from "../../domain/PullRequest.ts"
import type { Diagnostic } from "../../domain/Snapshot.ts"
import { GitHub, maximumBatch, type ItemResult } from "../../ports/GitHub.ts"
import { CommandRunner, layer as commandLayer } from "../Command.ts"
import { failure, makePost, type Envelope, type Post } from "./Post.ts"
import { alias, batch, continuation } from "./Query.ts"
import { layer as rateLimitLayer } from "./RateLimit.ts"
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
import { layer as tokenLayer } from "./Token.ts"

const ContinuationData = Schema.Struct({
  resource: Schema.Struct({ statusCheckRollup: Schema.Struct({ contexts: Contexts }) }),
})

const failed = (diagnostic: Diagnostic): ItemResult => ({ _tag: "Failed", diagnostic })

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

    if (after === "" || followed.has(after)) return yield* failure("InvalidResponse")

    followed.add(after)

    const envelope = yield* post(continuation(), { cursor: after, url: node.url })

    if ((envelope.errors ?? []).length > 0) return yield* failure("InvalidResponse")

    const data = yield* Schema.decodeUnknownEffect(ContinuationData)(envelope.data).pipe(
      Effect.mapError(() => failure("InvalidResponse")),
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
  readonly post: Post
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

  if (Option.isSome(reported)) return failed(reported.value)

  if (Option.isNone(raw)) return failed("NotFound")

  const node = Schema.decodeUnknownOption(PullRequestNode)(raw.value)

  if (Option.isNone(node)) return failed("InvalidResponse")

  const contexts = yield* Effect.result(allContexts(post, node.value))

  if (Result.isFailure(contexts)) return failed(contexts.failure.diagnostic)

  return {
    _tag: "Reported",
    report: toReport(ref, node.value, contexts.success),
  } satisfies ItemResult
})

const fetchBatch = Effect.fn("fetchBatch")(function* (post: Post, refs: readonly PullRequestRef[]) {
  const variables = Object.fromEntries(refs.map((ref, index) => [alias(index), ref.url]))
  const envelope = yield* post(batch(refs.length), variables)

  const results = yield* Effect.forEach(
    refs,
    (ref, index) =>
      itemResult({ aliases: new Set(Object.keys(variables)), envelope, post }, ref, alias(index)),
    {
      concurrency: 4,
    },
  )

  return Arr.zip(
    refs.map((ref) => ref.url),
    results,
  )
})

/** A batch's results; when the whole batch failed, a failure for each of its pull requests. */
const outcomeOf = (post: Post, refs: readonly PullRequestRef[]): Effect.Effect<BatchOutcome> =>
  Effect.gen(function* () {
    const result = yield* Effect.result(fetchBatch(post, refs))

    if (Result.isSuccess(result)) return { entries: result.success, failure: Option.none() }

    const { diagnostic } = result.failure

    return {
      entries: refs.map((ref): Entry => [ref.url, { _tag: "Failed", diagnostic }]),
      failure: Option.some(diagnostic),
    }
  })

/** The GitHub port over GraphQL. Requires an HTTP client, a token source, a rate limit, and `gh`. */
export const layer = Layer.effect(
  GitHub,
  Effect.gen(function* () {
    const post = yield* makePost()
    const runner = yield* CommandRunner

    return GitHub.of({
      fetch: (refs) => {
        const batches = Arr.chunksOf(
          Arr.dedupeWith(refs, (left, right) => left.url === right.url),
          maximumBatch,
        )

        return Effect.forEach(batches, (refsInBatch: readonly PullRequestRef[]) =>
          outcomeOf(post, refsInBatch),
        ).pipe(
          Effect.flatMap((outcomes: readonly BatchOutcome[]) =>
            Effect.fromResult(combined(outcomes)),
          ),
          Effect.mapError(failure),
        )
      },
      pullRequestInRepository: (directory, number) =>
        resolveInRepository(directory, number).pipe(Effect.provideService(CommandRunner, runner)),
    })
  }),
)

/**
 * The GitHub port over `api.github.com`, with tokens from the environment or `gh`, and rate-limit
 * waits kept in plugin storage.
 */
export const live = (storage: StorageDomain): Layer.Layer<GitHub> =>
  layer.pipe(
    Layer.provide([tokenLayer, rateLimitLayer(storage)]),
    Layer.provide([commandLayer, FetchHttpClient.layer]),
  )
