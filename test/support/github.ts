import { readFileSync } from "node:fs"
import path from "node:path"

import { Effect, Exit, Layer, Logger, Option, Redacted, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest,
} from "effect/unstable/http"

import { layer as clientLayer } from "../../src/adapters/github/Client.ts"
import { layer as rateLimitLayer } from "../../src/adapters/github/RateLimit.ts"
import { Token } from "../../src/adapters/github/Token.ts"
import { parsePullRequestUrl, type PullRequestRef } from "../../src/domain/PullRequest.ts"
import type { ReviewMode } from "../../src/domain/Review.ts"
import { GitHub, type GitHubApi, type ItemResult } from "../../src/ports/GitHub.ts"
import { memoryStorage, type StorageFake } from "./application.ts"
import { fixedCommands, type CommandsFake } from "./commands.ts"
import { Exchange, exchangeKey, queryDigest, Variables } from "./exchange.ts"
import { answeredNode } from "./lookup.ts"

const Fixture = Schema.fromJsonString(Schema.Struct({ exchanges: Schema.Array(Exchange) }))

const RequestBody = Schema.fromJsonString(
  Schema.Struct({ query: Schema.String, variables: Variables }),
)

export type RequestBody = typeof RequestBody.Type

export function fixture(name: string): readonly Exchange[] {
  const file = path.join(import.meta.dir, "..", "fixtures", "github", `${name}.json`)

  return Schema.decodeUnknownSync(Fixture)(readFileSync(file, "utf8")).exchanges
}

/** The recorded pull request node for `alias` in the first exchange of fixture `name`. */
export const recordedNode = (name: string, alias: string): Schema.Json =>
  Option.match(Option.fromNullishOr(fixture(name)[0]), {
    onNone: () => null,
    onSome: (first: Exchange) => answeredNode(first.response, alias),
  })

function bodyOf(request: HttpClientRequest.HttpClientRequest): RequestBody {
  const bytes = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array()

  return Schema.decodeUnknownSync(RequestBody)(new TextDecoder().decode(bytes))
}

/** A response, or `"unreachable"` for a request that never reached GitHub. */
export type Responder = (body: RequestBody, count: number) => Response | "unreachable"

export interface HttpFake {
  readonly layer: Layer.Layer<HttpClient.HttpClient>
  /** Every request body received, in order. */
  readonly requests: readonly RequestBody[]
}

/** An HTTP client that answers with `respond` and records every request body it received. */
export function httpClient(respond: Responder): HttpFake {
  const requests: RequestBody[] = []

  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.suspend(() => {
      const body = bodyOf(request)

      requests.push(body)

      const response = respond(body, requests.length)

      return response === "unreachable"
        ? Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            }),
          )
        : Effect.succeed(HttpClientResponse.fromWeb(request, response))
    }),
  )

  return { layer: Layer.succeed(HttpClient.HttpClient, client), requests }
}

/** Replays recorded exchanges by query and variables; an unrecorded request gets a 599. */
export function replay(exchanges: readonly Exchange[]): HttpFake {
  const responses = new Map(
    exchanges.map((exchange: Exchange) => [
      exchangeKey(exchange.queryDigest, exchange.variables),
      exchange.response,
    ]),
  )

  return httpClient((body: RequestBody) =>
    Option.match(
      Option.fromNullishOr(responses.get(exchangeKey(queryDigest(body.query), body.variables))),
      {
        onNone: () => new Response("unrecorded request", { status: 599 }),
        onSome: (response: Schema.Json) => Response.json(response),
      },
    ),
  )
}

export interface TokenFake {
  readonly layer: Layer.Layer<Token>
  /** How often the client asked the token source to forget its token. */
  readonly invalidations: () => number
}

export function fixedToken(): TokenFake {
  let invalidations = 0

  const layer = Layer.succeed(
    Token,
    Token.of({
      get: Effect.succeed(Redacted.make("recorded-token")),
      invalidate: Effect.sync(() => {
        invalidations += 1
      }),
    }),
  )

  return { invalidations: () => invalidations, layer }
}

export const acmeRef = (number: number): PullRequestRef =>
  Result.getOrThrow(parsePullRequestUrl(`github.com/acme/api/pull/${String(number)}`))

export const trackerRef = (number: number): PullRequestRef =>
  Result.getOrThrow(
    parsePullRequestUrl(`github.com/hcrosse/opencode-pr-tracker/pull/${String(number)}`),
  )

/** hcrosse/opencode-pr-tracker#127, whose response is recorded in the standalone fixture. */
export const tracker127: PullRequestRef = trackerRef(127)

export const fetchOne = (
  github: GitHubApi,
): Effect.Effect<ReadonlyMap<string, ItemResult>, unknown> => github.fetch([acmeRef(1)])

/** Fetches at each time on a test clock, returning how many requests had been sent after each. */
export const requestsAt =
  (http: HttpFake, times: readonly number[]) =>
  (github: GitHubApi): Effect.Effect<readonly number[]> =>
    Effect.forEach(times, (time: number) =>
      TestClock.setTime(time).pipe(
        Effect.andThen(Effect.exit(fetchOne(github))),
        Effect.andThen(Effect.sync(() => http.requests.length)),
      ),
    ).pipe(Effect.provide(TestClock.layer()))

export const recordedPullRequest = recordedNode("standalone", "pr0")

export interface ClientSetup {
  readonly http: HttpFake
  readonly commands?: CommandsFake
  readonly token?: TokenFake
  /** Plugin storage, where rate-limit waits are kept. Share one to model several plugin instances. */
  readonly storage?: StorageFake
  readonly reviews?: ReviewMode
  /** Check contexts the client asks for per page. */
  readonly pageSize?: number
}

/** Runs `use` against the real GitHub client over fake HTTP, token, storage and `gh`. */
export async function runClient<A, E>(
  setup: ClientSetup,
  use: (github: GitHubApi) => Effect.Effect<A, E>,
): Promise<Exit.Exit<A, E>> {
  const token = setup.token ?? fixedToken()
  const commands = setup.commands ?? fixedCommands({})
  const storage = setup.storage ?? memoryStorage()

  const layer = clientLayer(setup.reviews ?? "all", setup.pageSize).pipe(
    Layer.provide([setup.http.layer, token.layer, commands.layer, rateLimitLayer(storage.storage)]),
  )

  // Failed requests log warnings. Tests that check them provide their own logger.
  const quiet = Logger.layer([])

  const result = await Effect.runPromise(
    Effect.exit(GitHub.use(use).pipe(Effect.provide([layer, quiet]))),
  )

  return result
}
