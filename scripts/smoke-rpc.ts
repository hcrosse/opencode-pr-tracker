/**
 * Exercises the plugin's RPC through the real OpenCode client, against the smoke-test server.
 * GitHub steps run only when a token is available.
 */
import { Location, OpenCode, Session, type AppApi, type RpcClient } from "@opencode/client/effect"
import {
  Effect,
  Fiber,
  Latch,
  Layer,
  Option,
  Result,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"

import { PullRequestTracker, View, type ViewData } from "../src/rpc.ts"

type Tracker = RpcClient<PullRequestTracker, unknown>

type Client = AppApi<unknown>

const updatedEvent = `rpc.${PullRequestTracker.id}.updated`

export interface Server {
  readonly url: string
  readonly password: string
  /** The project directory where the plugin is configured. */
  readonly project: string
}

const unusedSession = "ses_smoke"

/** Routes each call to the plugin instance for the smoke-test project. */
interface Routing {
  readonly location: Location.PublicRef
}

const stack = [
  "https://github.com/hcrosse/opencode-pr-tracker/pull/78",
  "https://github.com/hcrosse/opencode-pr-tracker/pull/79",
]

const urlsOf = (view: ViewData): string[] =>
  view.entries.map(
    ({ ref }) => `https://github.com/${ref.owner}/${ref.repository}/pull/${String(ref.number)}`,
  )

function expectEqual<A>(label: string, actual: A, expected: A): Effect.Effect<void> {
  return JSON.stringify(actual) === JSON.stringify(expected)
    ? Effect.logInfo(`ok: ${label}`)
    : Effect.die(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** An HTTP client that signs every request in as the smoke-test server's user. */
const authorized = (password: string): Layer.Layer<HttpClient.HttpClient> =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient

      return HttpClient.mapRequest(client, HttpClientRequest.basicAuth("opencode", password))
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))

const RpcFailure = Schema.Struct({ type: Schema.String })

const withoutGitHub = Effect.fn("withoutGitHub")(function* (tracker: Tracker, location: Routing) {
  const empty = yield* tracker.list({ sessionID: unusedSession }, location)

  yield* expectEqual(
    "an unused session is empty, in the configured layout",
    [empty.entries, empty.layout],
    [[], "compact"],
  )

  const rejected = yield* Effect.flip(
    tracker.attach({ sessionID: unusedSession, target: "not a pull request" }, location),
  )

  const failure = Option.map(
    Schema.decodeUnknownOption(RpcFailure)(rejected),
    (error) => error.type,
  )

  yield* expectEqual("an invalid target is rejected", failure, Option.some("rejected"))
})

const RpcEvent = Schema.Struct({ data: Schema.toEncoded(View), type: Schema.Literal(updatedEvent) })

/** The session whose `updated` events a step expects, and the client that receives them. */
interface Watched {
  readonly client: Client
  readonly sessionID: string
}

/**
 * Runs `act` once the event stream is connected, so no event is missed, then requires an `updated`
 * event for the session that lists exactly `expected`.
 */
function expectUpdate<A, E>(
  { client, sessionID }: Watched,
  expected: readonly string[],
  act: Effect.Effect<A, E>,
): Effect.Effect<A, E, Scope.Scope> {
  return Effect.gen(function* () {
    const connected = yield* Latch.make()

    const update = yield* client.event.subscribe().pipe(
      Stream.tap((event) => (event.type === "server.connected" ? connected.open : Effect.void)),
      Stream.filterMap((event) =>
        Result.fromOption(Schema.decodeUnknownOption(RpcEvent)(event), () => event),
      ),
      Stream.filter(
        ({ data }) => data.sessionID === sessionID && urlsOf(data).join(" ") === expected.join(" "),
      ),
      Stream.runHead,
      Effect.timeoutOption("30 seconds"),
      Effect.map(Option.flatten),
      Effect.orElseSucceed(Option.none),
      Effect.forkScoped,
    )

    yield* connected.await

    const result = yield* act
    const updated = yield* Fiber.join(update)

    yield* expectEqual(`publishes ${expected.join(", ")}`, Option.isSome(updated), true)

    return result
  })
}

/** The smoke-test server's client, the plugin's RPC client, and where the plugin runs. */
interface Harness {
  readonly client: Client
  readonly tracker: Tracker
  readonly location: Routing
}

const removeSession = Effect.fn("removeSession")(function* (
  { client, location, tracker }: Harness,
  sessionID: Session.ID,
) {
  yield* client.session.remove({ sessionID })

  const forgotten = yield* tracker.list({ sessionID }, location).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("200 millis"),
      until: (view) => view.entries.length === 0,
    }),
    Effect.timeoutOption("10 seconds"),
  )

  yield* expectEqual(
    "deleting the session forgets its attachments",
    Option.map(forgotten, urlsOf),
    Option.some([]),
  )
})

const withGitHub = Effect.fn("withGitHub")(function* (harness: Harness) {
  const { client, location, tracker } = harness
  const session = yield* client.session.create(location)
  const sessionID = session.id

  const watched: Watched = { client, sessionID }

  const attached = yield* expectUpdate(
    watched,
    stack,
    tracker.attach(
      { sessionID, target: "github.com/hcrosse/opencode-pr-tracker/pull/78" },
      location,
    ),
  )

  yield* expectEqual("attaching a Stack member attaches the Stack", urlsOf(attached.view), stack)

  const detached = yield* expectUpdate(
    watched,
    stack.slice(0, 1),
    tracker.detach({ sessionID, target: stack[1] ?? "" }, location),
  )

  yield* expectEqual("detaching a member leaves the rest", urlsOf(detached.view), stack.slice(0, 1))

  const listed = yield* tracker.list({ sessionID }, location)

  yield* expectEqual("attachments are stored", urlsOf(listed), stack.slice(0, 1))
  yield* removeSession(harness, sessionID)
})

export const exerciseRpc = Effect.fn("exerciseRpc")(function* (server: Server, github: boolean) {
  const client = yield* OpenCode.make({ baseUrl: server.url }).pipe(
    Effect.provide(authorized(server.password)),
  )

  const tracker: Tracker = client.rpc(PullRequestTracker)

  const location: Routing = {
    location: Schema.decodeSync(Location.PublicRef)({ directory: server.project }),
  }

  yield* withoutGitHub(tracker, location)

  if (github) yield* Effect.scoped(withGitHub({ client, location, tracker }))
  else yield* Effect.logWarning("GH_TOKEN is not set; skipped the GitHub steps")
})
