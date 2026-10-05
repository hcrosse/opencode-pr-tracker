/** Posting one GraphQL document to GitHub: token refresh, rate limits, and failure logs. */
import { Clock, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"

import type { Diagnostic } from "../../domain/Snapshot.ts"
import { GitHubFailure } from "../../ports/GitHub.ts"
import { RateLimit, verdictOf, type Evidence, type RateLimitApi } from "./RateLimit.ts"
import { Token, type TokenApi } from "./Token.ts"

const endpoint = "https://api.github.com/graphql"

const GraphQlError = Schema.Struct({
  message: Schema.optional(Schema.String),
  path: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
  type: Schema.optional(Schema.String),
})

const Envelope = Schema.Struct({
  data: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  errors: Schema.optional(Schema.Array(GraphQlError)),
})

export type Envelope = typeof Envelope.Type

const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(Envelope))

export type Variables = Readonly<Record<string, string>>

/** Posts one GraphQL document and decodes GitHub's response envelope. */
export type Post = (query: string, variables: Variables) => Effect.Effect<Envelope, GitHubFailure>

export const failure = (diagnostic: Diagnostic): GitHubFailure => new GitHubFailure({ diagnostic })

/** A 401 from GitHub: the cached token may be stale. */
class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

const millis = Effect.map(Clock.currentTimeMillis, Math.floor)

const loggedHeaders = [
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-resource",
  "x-ratelimit-used",
]

/** A request GitHub did not answer: its response, and any GraphQL error messages. */
interface Refusal {
  readonly evidence: Evidence
  readonly messages: readonly string[]
}

/** Logs a failed request with what GitHub said, so rate limits and timeouts can be told apart. */
function logFailure({ evidence, messages }: Refusal, started: number): Effect.Effect<void> {
  return Effect.gen(function* () {
    const headers = Object.fromEntries(
      loggedHeaders.flatMap((name) =>
        Option.toArray(
          Option.map(Option.fromNullishOr(evidence.headers[name]), (value) => [name, value]),
        ),
      ),
    )

    yield* Effect.logWarning("GitHub request failed").pipe(
      Effect.annotateLogs({
        body: evidence.body.slice(0, 300),
        durationMs: (yield* millis) - started,
        errorTypes: evidence.errorTypes.join(","),
        headers: JSON.stringify(headers),
        messages: messages.join(" | "),
        status: evidence.status,
      }),
    )
  })
}

/** Logs a request that got no response at all, such as when the network is down. */
const logUnreachable = (reason: string, started: number): Effect.Effect<void> =>
  logFailure(
    { evidence: { body: reason, errorTypes: [], headers: {}, status: 0 }, messages: [] },
    started,
  )

/** A failure for a request GitHub did not answer, recording any rate limit it reports. */
const refused = Effect.fn("refused")(function* (
  rateLimit: RateLimitApi,
  refusal: Refusal,
  started: number,
) {
  yield* logFailure(refusal, started)

  const verdict = verdictOf(refusal.evidence, yield* millis)

  if (verdict._tag === "Allowed") return yield* failure("GitHubUnavailable")

  yield* rateLimit.limited(verdict.until)

  return yield* failure("RateLimited")
})

/**
 * The envelope of a 2xx response. An envelope without data means GitHub could not run the query,
 * as when rate limited or timed out. A `RATE_LIMITED` error fails the request even with data.
 */
const answered = Effect.fn("answered")(function* (
  rateLimit: RateLimitApi,
  response: HttpClientResponse.HttpClientResponse,
  started: number,
) {
  const text = yield* response.text.pipe(Effect.mapError(() => failure("InvalidResponse")))

  const evidenceOf = (errorTypes: readonly string[]): Evidence => ({
    body: text,
    errorTypes,
    headers: response.headers,
    status: response.status,
  })

  const envelope = yield* decodeEnvelope(text).pipe(
    Effect.tapError(() => logFailure({ evidence: evidenceOf([]), messages: [] }, started)),
    Effect.mapError(() => failure("InvalidResponse")),
  )

  const errors = envelope.errors ?? []
  const errorTypes = errors.map((error) => error.type ?? "")

  if (Option.isNone(Option.fromNullishOr(envelope.data)) || errorTypes.includes("RATE_LIMITED")) {
    const messages = errors.map((error) => error.message ?? "")

    return yield* refused(rateLimit, { evidence: evidenceOf(errorTypes), messages }, started)
  }

  yield* rateLimit.answered

  return envelope
})

/** A non-2xx response: a 401 to retry with a fresh token, or a request GitHub refused. */
const rejected = Effect.fn("rejected")(function* (
  rateLimit: RateLimitApi,
  response: HttpClientResponse.HttpClientResponse,
  started: number,
) {
  const text = yield* Effect.orElseSucceed(response.text, () => "")

  const refusal: Refusal = {
    evidence: { body: text, errorTypes: [], headers: response.headers, status: response.status },
    messages: [],
  }

  if (response.status !== 401) return yield* refused(rateLimit, refusal, started)

  yield* logFailure(refusal, started)

  return yield* new Unauthorized()
})

interface Services {
  readonly http: HttpClient.HttpClient
  readonly token: TokenApi
  readonly rateLimit: RateLimitApi
}

const attempt = Effect.fn("attempt")(function* (
  services: Services,
  query: string,
  variables: Variables,
) {
  yield* services.rateLimit.check

  const bearer = yield* services.token.get
  const started = yield* millis

  const request = HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.bearerToken(Redacted.value(bearer)),
    HttpClientRequest.bodyJsonUnsafe({ query, variables }),
  )

  const response = yield* services.http.execute(request).pipe(
    Effect.tapError((error: { readonly message: string }) =>
      logUnreachable(error.message, started),
    ),
    Effect.mapError(() => failure("GitHubUnavailable")),
  )

  const ok = response.status >= 200 && response.status < 300

  return yield* ok
    ? answered(services.rateLimit, response, started)
    : rejected(services.rateLimit, response, started)
})

/**
 * Posts one GraphQL document. A 401 refreshes the token and retries once. A rate-limited response
 * stops every request until GitHub's wait ends, as `RateLimit` records it.
 */
export const makePost = Effect.fn("makePost")(function* (): Effect.fn.Return<
  Post,
  never,
  HttpClient.HttpClient | Token | RateLimit
> {
  const services: Services = {
    http: yield* HttpClient.HttpClient,
    rateLimit: yield* RateLimit,
    token: yield* Token,
  }

  return (query: string, variables: Variables): Effect.Effect<Envelope, GitHubFailure> =>
    attempt(services, query, variables).pipe(
      Effect.catchTag("Unauthorized", () =>
        Effect.andThen(services.token.invalidate, attempt(services, query, variables)),
      ),
      Effect.catchTag("Unauthorized", () => Effect.fail(failure("AuthenticationRequired"))),
    )
})
