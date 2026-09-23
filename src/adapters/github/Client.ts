import { Array as Arr, Effect, Layer, Option, Redacted, Result, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"

import type { PullRequestRef } from "../../domain/PullRequest.ts"
import type { Diagnostic } from "../../domain/Snapshot.ts"
import { GitHub, GitHubFailure, maximumBatch, type ItemResult } from "../../ports/GitHub.ts"
import { CommandRunner, layer as commandLayer } from "./Command.ts"
import { alias, batch, continuation } from "./Query.ts"
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
import { Token, layer as tokenLayer } from "./Token.ts"

const endpoint = "https://api.github.com/graphql"

const GraphQlError = Schema.Struct({
  path: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
  type: Schema.optional(Schema.String),
})

const Envelope = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  errors: Schema.optional(Schema.Array(GraphQlError)),
})

type Envelope = typeof Envelope.Type

const ContinuationData = Schema.Struct({
  resource: Schema.Struct({ statusCheckRollup: Schema.Struct({ contexts: Contexts }) }),
})

const failure = (diagnostic: Diagnostic): GitHubFailure => new GitHubFailure({ diagnostic })

/** A 401 from GitHub: the cached token may be stale. */
class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

const failed = (diagnostic: Diagnostic): ItemResult => ({ _tag: "Failed", diagnostic })

const decodeEnvelope = Schema.decodeUnknownEffect(Envelope)

type Variables = Readonly<Record<string, string>>

/** Posts one GraphQL document and decodes GitHub's response envelope. */
type Post = (query: string, variables: Variables) => Effect.Effect<Envelope, GitHubFailure>

/** Posts one GraphQL document. A 401 refreshes the token and retries once. */
const makePost = Effect.fn("makePost")(function* (): Effect.fn.Return<
  Post,
  never,
  HttpClient.HttpClient | Token
> {
  const http = yield* HttpClient.HttpClient
  const token = yield* Token

  const attempt = Effect.fn("attempt")(function* (query: string, variables: Variables) {
    const bearer = yield* token.get

    const request = HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.bearerToken(Redacted.value(bearer)),
      HttpClientRequest.bodyJsonUnsafe({ query, variables }),
    )

    const response = yield* http
      .execute(request)
      .pipe(Effect.mapError(() => failure("GitHubUnavailable")))

    if (response.status === 401) return yield* new Unauthorized()

    if (response.status < 200 || response.status >= 300) return yield* failure("GitHubUnavailable")

    const body = yield* response.json.pipe(Effect.mapError(() => failure("InvalidResponse")))

    return yield* decodeEnvelope(body).pipe(Effect.mapError(() => failure("InvalidResponse")))
  })

  return (query: string, variables: Variables): Effect.Effect<Envelope, GitHubFailure> =>
    attempt(query, variables).pipe(
      Effect.catchTag("Unauthorized", () =>
        Effect.andThen(token.invalidate, attempt(query, variables)),
      ),
      Effect.catchTag("Unauthorized", () => Effect.fail(failure("AuthenticationRequired"))),
    )
})

/** Every check context for a pull request, following continuation pages. */
const allContexts = Effect.fn("allContexts")(function* (post: Post, node: PullRequestNode) {
  const collected: ContextNode[] = []
  let page = Option.map(Option.fromNullishOr(node.statusCheckRollup), (rollup) => rollup.contexts)

  while (Option.isSome(page)) {
    collected.push(...page.value.nodes)

    const cursor = page.value.pageInfo.hasNextPage
      ? Option.fromNullishOr(page.value.pageInfo.endCursor)
      : Option.none()

    page = yield* Option.match(cursor, {
      onNone: () => Effect.succeed(Option.none<Contexts>()),
      onSome: (after) =>
        post(continuation(), { cursor: after, url: node.url }).pipe(
          Effect.flatMap((envelope) => Schema.decodeUnknownEffect(ContinuationData)(envelope.data)),
          Effect.map((data) => Option.some(data.resource.statusCheckRollup.contexts)),
          Effect.mapError(() => failure("InvalidResponse")),
        ),
    })
  }

  return collected
})

/** GraphQL error types meaning the pull request does not exist or this token cannot see it. */
const inaccessible = new Set(["NOT_FOUND", "FORBIDDEN"])

function aliasFailure(envelope: Envelope, key: string): Option.Option<Diagnostic> {
  const errors = (envelope.errors ?? []).filter((error) => (error.path ?? [])[0] === key)

  return Arr.matchLeft(errors, {
    onEmpty: () => Option.none(),
    onNonEmpty: (first) =>
      Option.some(inaccessible.has(first.type ?? "") ? "NotFound" : "InvalidResponse"),
  })
}

interface Batch {
  readonly post: Post
  readonly envelope: Envelope
}

const itemResult = Effect.fn("itemResult")(function* (
  { envelope, post }: Batch,
  ref: PullRequestRef,
  key: string,
) {
  const reported = aliasFailure(envelope, key)
  const raw = Option.fromNullishOr((envelope.data ?? {})[key])

  if (Option.isSome(reported)) return failed(reported.value)

  if (Option.isNone(raw)) return failed("NotFound")

  const node = Schema.decodeUnknownOption(PullRequestNode)(raw.value)

  if (Option.isNone(node)) return failed("InvalidResponse")

  const contexts = yield* allContexts(post, node.value).pipe(Effect.option)

  return Option.match(contexts, {
    onNone: () => failed("InvalidResponse"),
    onSome: (nodes: readonly ContextNode[]): ItemResult => ({
      _tag: "Reported",
      report: toReport(ref, node.value, nodes),
    }),
  })
})

const fetchBatch = Effect.fn("fetchBatch")(function* (post: Post, refs: readonly PullRequestRef[]) {
  const variables = Object.fromEntries(refs.map((ref, index) => [alias(index), ref.url]))
  const envelope = yield* post(batch(refs.length), variables)

  // GitHub answers a request it could not run at all, such as a rate-limited one, without data.
  if (Option.isNone(Option.fromNullishOr(envelope.data))) return yield* failure("GitHubUnavailable")

  const results = yield* Effect.forEach(
    refs,
    (ref, index) => itemResult({ envelope, post }, ref, alias(index)),
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

/** The GitHub port over GraphQL. Requires an HTTP client, a token source, and `gh`. */
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

/** The GitHub port over `api.github.com`, with tokens from the environment or `gh`. */
export const live = layer.pipe(
  Layer.provide(tokenLayer),
  Layer.provide([commandLayer, FetchHttpClient.layer]),
)
