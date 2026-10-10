/** Posting one GraphQL document to GitHub: token refresh, rate limits, and failure logs. */
import { Clock, Effect, Option, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"

import { Diagnostic } from "../../domain/Snapshot.ts"
import type { GitHubFailure } from "../../ports/GitHub.ts"
import { RateLimit, Verdict, verdictOf, type Evidence, type RateLimitApi } from "./RateLimit.ts"
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

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const decodeEnvelope = Schema.decodeUnknownOption(Envelope)

/** GraphQL variables: strings, and pull request numbers. */
export type Variables = Readonly<Record<string, string | number>>

/** A request that got no usable answer and cost GitHub no work. */
export class RequestFailed extends Schema.TaggedError<RequestFailed>()("RequestFailed", {
  diagnostic: Diagnostic,
}) {}

/**
 * The work an unanswered request cost GitHub. `TimedOut` is a query GitHub could not finish in
 * time: a 502, a 504, or a 2xx answer cut off before its end. `Charged` is another server error.
 */
const Charge = Schema.Literals(["Charged", "TimedOut"])

export type Charge = typeof Charge.Type

/** A request GitHub spent work on without answering, so GitHub is unavailable. */
export class RequestCharged extends Schema.TaggedError<RequestCharged>()("RequestCharged", {
  charge: Charge,
}) {}

export type PostFailure = RequestFailed | RequestCharged

/** Posts one GraphQL document and decodes GitHub's response envelope. */
export type Post = (query: string, variables: Variables) => Effect.Effect<Envelope, PostFailure>

export const failure = (diagnostic: Diagnostic): RequestFailed => new RequestFailed({ diagnostic })

/** A failure found before any request reached GitHub. */
const free = (refused: GitHubFailure): RequestFailed => failure(refused.diagnostic)

/** A 401 from GitHub: the cached token may be stale. */
class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

const millis = Effect.map(Clock.currentTimeMillis, Math.floor)

const loggedHeader = (name: string): boolean =>
  name === "retry-after" || name.startsWith("x-ratelimit-")

/** Logs a failed request with what GitHub said, so rate limits and timeouts can be told apart. */
const logFailure = Effect.fn("Post.logFailure")(function* (
  evidence: Evidence,
  messages: readonly string[],
  started: number,
): Effect.fn.Return<void> {
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

const timeoutStatuses = new Set([502, 504])

/** The failure for an unavailable GitHub: charged for a timeout or another server error. */
function unavailable(evidence: Evidence, cutOff: boolean): PostFailure {
  if (cutOff || timeoutStatuses.has(evidence.status))
    return new RequestCharged({ charge: "TimedOut" })

  return evidence.status >= 500
    ? new RequestCharged({ charge: "Charged" })
    : failure("GitHubUnavailable")
}

/**
 * What a 2xx body holds, if it is not a usable answer: one cut off before its end; a complete one
 * that is not a GraphQL answer, such as an HTML page or JSON with neither data nor errors; or other.
 */
type Unusable = "CutOff" | "Invalid" | "Other"

/** Whether the response labels its body as JSON, as GitHub's answers are. */
function labelledJson(headers: Readonly<Record<string, string | undefined>>): boolean {
  const [mediaType = ""] = (headers["content-type"] ?? "").split(";")
  const type = mediaType.trim().toLowerCase()

  return type === "application/json" || type.endsWith("+json")
}

/**
 * Whether a body that is not a usable answer was cut off, as when GitHub stops sending it: it
 * could not be read, is empty, or is labelled JSON but does not parse. The label decides only how
 * a body that does not parse is read; a complete, non-empty body not labelled JSON is invalid.
 */
function cutOffBody(
  response: HttpClientResponse.HttpClientResponse,
  body: string,
  json: Option.Option<unknown>,
): boolean {
  return body.trim() === "" || (Option.isNone(json) && labelledJson(response.headers))
}

function unusableBody(cutOff: boolean, envelope: Option.Option<Envelope>): Unusable {
  if (cutOff) return "CutOff"

  return Option.exists(envelope, (found) => (found.errors ?? []).length > 0) ? "Other" : "Invalid"
}

/** The failure for a response that was not a usable answer, recording any rate limit it reports. */
const unanswered = Effect.fn("Post.unanswered")(function* (
  rateLimit: RateLimitApi,
  evidence: Evidence,
  unusable: Unusable,
) {
  if (evidence.status === 401) return yield* new Unauthorized()

  if (unusable === "Invalid") return yield* failure("InvalidResponse")

  const verdict = verdictOf(evidence, yield* millis)

  if (Verdict.$is("Allowed")(verdict)) return yield* unavailable(evidence, unusable === "CutOff")

  yield* rateLimit.limited(verdict.until)

  return yield* failure("RateLimited")
})

interface Services {
  readonly http: HttpClient.HttpClient
  readonly token: TokenApi
  readonly rateLimit: RateLimitApi
}

/**
 * The envelope of a usable answer: a 2xx envelope with data and no `RATE_LIMITED` error, whatever
 * the body's Content-Type. Anything else, such as a rate-limited or timed-out query, is logged and
 * fails.
 */
const read = Effect.fn("Post.read")(function* (
  rateLimit: RateLimitApi,
  response: HttpClientResponse.HttpClientResponse,
  started: number,
) {
  // A body that could not be read counts as cut off, like one that ended early.
  const body = yield* Effect.orElseSucceed(response.text, () => "")
  const ok = response.status >= 200 && response.status < 300
  const json = ok ? parseJson(body) : Option.none()
  const envelope = Option.flatMap(json, decodeEnvelope)
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

  const unusable = ok ? unusableBody(cutOffBody(response, body, json), envelope) : "Other"

  return yield* unanswered(rateLimit, evidence, unusable)
})

const attempt = Effect.fn("Post.attempt")(function* (
  services: Services,
  query: string,
  variables: Variables,
) {
  yield* Effect.mapError(services.rateLimit.check, free)

  const bearer = yield* Effect.mapError(services.token.get, free)
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
export const makePost = Effect.fn("Post.makePost")(function* (): Effect.fn.Return<
  Post,
  never,
  HttpClient.HttpClient | Token | RateLimit
> {
  const services: Services = {
    http: yield* HttpClient.HttpClient,
    rateLimit: yield* RateLimit,
    token: yield* Token,
  }

  return (query: string, variables: Variables): Effect.Effect<Envelope, PostFailure> =>
    attempt(services, query, variables).pipe(
      Effect.catchTag("Unauthorized", () =>
        Effect.andThen(services.token.invalidate, attempt(services, query, variables)),
      ),
      Effect.catchTag("Unauthorized", () => Effect.fail(failure("AuthenticationRequired"))),
    )
})
