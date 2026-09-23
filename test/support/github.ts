import { readFileSync } from "node:fs"
import path from "node:path"

import { Effect, Exit, Layer, Option, Redacted, Result, Schema } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http"

import { CommandFailed, CommandMissing, CommandRunner } from "../../src/adapters/Command.ts"
import { layer as clientLayer } from "../../src/adapters/github/Client.ts"
import { Token } from "../../src/adapters/github/Token.ts"
import { parsePullRequestUrl, type PullRequestRef } from "../../src/domain/PullRequest.ts"
import { GitHub, type GitHubApi, type ItemResult } from "../../src/ports/GitHub.ts"

const Exchange = Schema.Struct({
  response: Schema.Json,
  variables: Schema.Record(Schema.String, Schema.String),
})

const Fixture = Schema.fromJsonString(Schema.Struct({ exchanges: Schema.Array(Exchange) }))

const RequestBody = Schema.fromJsonString(
  Schema.Struct({ query: Schema.String, variables: Schema.Record(Schema.String, Schema.String) }),
)

const BatchData = Schema.Struct({ data: Schema.Record(Schema.String, Schema.Json) })

export type Exchange = typeof Exchange.Type

export type RequestBody = typeof RequestBody.Type

const key = (variables: Readonly<Record<string, string>>): string =>
  JSON.stringify(
    Object.entries(variables).toSorted(
      ([left]: readonly [string, string], [right]: readonly [string, string]) =>
        left.localeCompare(right),
    ),
  )

export function fixture(name: string): readonly Exchange[] {
  const file = path.join(import.meta.dir, "..", "fixtures", "github", `${name}.json`)

  return Schema.decodeUnknownSync(Fixture)(readFileSync(file, "utf8")).exchanges
}

/** The recorded GraphQL node for `alias` in the first exchange of fixture `name`. */
export function recordedNode(name: string, alias: string): Schema.Json {
  return Option.match(Option.fromNullishOr(fixture(name)[0]), {
    onNone: () => null,
    onSome: (first: Exchange) =>
      Schema.decodeUnknownSync(BatchData)(first.response).data[alias] ?? null,
  })
}

function bodyOf(request: HttpClientRequest.HttpClientRequest): RequestBody {
  const bytes = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array()

  return Schema.decodeUnknownSync(RequestBody)(new TextDecoder().decode(bytes))
}

export type Responder = (body: RequestBody, count: number) => Response

export interface HttpFake {
  readonly layer: Layer.Layer<HttpClient.HttpClient>
  /** Every request body received, in order. */
  readonly requests: readonly RequestBody[]
}

/** An HTTP client that answers with `respond` and records every request body it received. */
export function httpClient(respond: Responder): HttpFake {
  const requests: RequestBody[] = []

  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
    Effect.sync(() => {
      const body = bodyOf(request)

      requests.push(body)

      return HttpClientResponse.fromWeb(request, respond(body, requests.length))
    }),
  )

  return { layer: Layer.succeed(HttpClient.HttpClient, client), requests }
}

/** Replays recorded exchanges by request variables; an unrecorded request gets a 599. */
export function replay(exchanges: readonly Exchange[]): HttpFake {
  const responses = new Map(
    exchanges.map((exchange: Exchange) => [key(exchange.variables), exchange.response]),
  )

  return httpClient((body: RequestBody) =>
    Option.match(Option.fromNullishOr(responses.get(key(body.variables))), {
      onNone: () => new Response("unrecorded request", { status: 599 }),
      onSome: (response: Schema.Json) => Response.json(response),
    }),
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

/** How a fixed command finishes. */
export type FixedOutcome =
  | { readonly _tag: "Output"; readonly stdout: string }
  | { readonly _tag: "Exit"; readonly exitCode: number; readonly stderr: string }

export const output = (stdout: string): FixedOutcome => ({ _tag: "Output", stdout })

export const exitWith = (exitCode: number, stderr: string): FixedOutcome => ({
  _tag: "Exit",
  exitCode,
  stderr,
})

function outcomeEffect(
  command: string,
  outcome: FixedOutcome,
): Effect.Effect<string, CommandFailed> {
  return outcome._tag === "Output"
    ? Effect.succeed(outcome.stdout)
    : Effect.fail(
        new CommandFailed({ command, exitCode: outcome.exitCode, stderr: outcome.stderr }),
      )
}

export interface CommandsFake {
  readonly layer: Layer.Layer<CommandRunner>
  /** Every command line run, in order. */
  readonly calls: readonly string[]
}

/** Runs commands from a fixed table keyed by `command args`; anything else is missing. */
export function fixedCommands(outcomes: Readonly<Record<string, FixedOutcome>>): CommandsFake {
  const calls: string[] = []

  const layer = Layer.succeed(
    CommandRunner,
    CommandRunner.of({
      run: (command: string, args: readonly string[]) =>
        Effect.gen(function* () {
          const line = [command, ...args].join(" ")

          calls.push(line)

          return yield* Option.match(Option.fromNullishOr(outcomes[line]), {
            onNone: () => Effect.fail(new CommandMissing({ command })),
            onSome: (outcome: FixedOutcome) => outcomeEffect(command, outcome),
          })
        }),
    }),
  )

  return { calls, layer }
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

export const recordedPullRequest = recordedNode("standalone", "pr0")

export interface ClientSetup {
  readonly http: HttpFake
  readonly commands?: CommandsFake
  readonly token?: TokenFake
}

/** Runs `use` against the real GitHub client over fake HTTP, token and `gh`. */
export async function runClient<A, E>(
  setup: ClientSetup,
  use: (github: GitHubApi) => Effect.Effect<A, E>,
): Promise<Exit.Exit<A, E>> {
  const token = setup.token ?? fixedToken()
  const commands = setup.commands ?? fixedCommands({})
  const layer = clientLayer.pipe(Layer.provide([setup.http.layer, token.layer, commands.layer]))
  const result = await Effect.runPromise(Effect.exit(GitHub.use(use).pipe(Effect.provide(layer))))

  return result
}
