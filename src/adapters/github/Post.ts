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

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(Envelope))

export type Variables = Readonly<Record<string, string>>

/** Posts one GraphQL document and decodes GitHub's response envelope. */
export type Post = (query: string, variables: Variables) => Effect.Effect<Envelope, GitHubFailure>

export const failure = (diagnostic: Diagnostic): GitHubFailure => new GitHubFailure({ diagnostic })

/** A 401 from GitHub: the cached token may be stale. */
class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

const millis = Effect.map(Clock.currentTimeMillis, Math.floor)

const loggedHeader = (name: string): boolean =>
  name === "retry-after" || name.startsWith("x-ratelimit-")

/** Logs a failed request with what GitHub said, so rate limits and timeouts can be told apart. */
function logFailure(
  evidence: Evidence,
  messages: readonly string[],
  started: number,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const headers = Object.fromEntries(
      Object.entries(evidence.headers).filter(([name]: readonly [string, unknown]) =>
        loggedHeader(name),
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

/** The failure for a response that was not a usable answer, recording any rate limit it reports. */
const unanswered = Effect.fn("unanswered")(function* (
  rateLimit: RateLimitApi,
  evidence: Evidence,
  undecodable: boolean,
) {
  if (evidence.status === 401) return yield* new Unauthorized()

  if (undecodable) return yield* failure("InvalidResponse")

  const verdict = verdictOf(evidence, yield* millis)

  if (verdict._tag === "Allowed") return yield* failure("GitHubUnavailable")

  yield* rateLimit.limited(verdict.until)

  return yield* failure("RateLimited")
})

interface Services {
  readonly http: HttpClient.HttpClient
  readonly token: TokenApi
  readonly rateLimit: RateLimitApi
}

/**
 * The envelope of a usable answer: a 2xx envelope with data and no `RATE_LIMITED` error. Anything
 * else, such as a rate-limited or timed-out query, is logged and fails.
 */
const read = Effect.fn("read")(function* (
  rateLimit: RateLimitApi,
  response: HttpClientResponse.HttpClientResponse,
  started: number,
) {
  const body = yield* Effect.orElseSucceed(response.text, () => "")
  const ok = response.status >= 200 && response.status < 300
  const envelope = ok ? decodeEnvelope(body) : Option.none()
  const errors = Option.match(envelope, { onNone: () => [], onSome: (found) => found.errors ?? [] })
  const errorTypes = errors.map((error) => error.type ?? "")

  const usable = Option.filter(
    envelope,
    (found) =>
      Option.isSome(Option.fromNullishOr(found.data)) && !errorTypes.includes("RATE_LIMITED"),
  )

  if (Option.isSome(usable)) return yield* Effect.as(rateLimit.answered, usable.value)

  const evidence = { body, errorTypes, headers: response.headers, status: response.status }

  yield* logFailure(
    evidence,
    errors.map((error) => error.message ?? ""),
    started,
  )

  return yield* unanswered(rateLimit, evidence, ok && Option.isNone(envelope))
})

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
      logFailure({ body: error.message, errorTypes: [], headers: {}, status: 0 }, [], started),
    ),
    Effect.mapError(() => failure("GitHubUnavailable")),
  )

  return yield* read(services.rateLimit, response, started)
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
