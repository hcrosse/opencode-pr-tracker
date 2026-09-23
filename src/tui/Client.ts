/** The terminal's view of the tracker: RPC calls routed to each session's location, decoded on arrival. */
import { Effect, Option, Schema } from "effect"

import { Changed, View, type ViewData } from "../rpc.ts"

export class RequestFailed extends Schema.TaggedError<RequestFailed>()("RequestFailed", {
  message: Schema.String,
}) {}

export interface TrackerClientApi {
  readonly list: (sessionID: string) => Effect.Effect<View, RequestFailed>
  readonly refresh: (sessionID: string) => Effect.Effect<View, RequestFailed>
  readonly attach: (sessionID: string, target: string) => Effect.Effect<Changed, RequestFailed>
  readonly detach: (sessionID: string, target: string) => Effect.Effect<Changed, RequestFailed>
  /** Calls `handler` with each view the server publishes. Returns a function that stops the calls. */
  readonly onUpdate: (handler: (view: View) => void) => () => void
}

/** Where a session runs; RPC calls go to the plugin instance for that location. */
export interface Location {
  readonly directory: string
  readonly workspaceID?: string
}

interface CallOptions {
  readonly location?: Location
}

interface Session {
  readonly sessionID: string
}

interface Target extends Session {
  readonly target: string
}

type ChangedData = typeof Changed.Encoded

/** The parts of the plugin's RPC client the terminal uses. */
export interface TrackerRpc {
  readonly list: (input: Session, options: CallOptions) => Promise<ViewData>
  readonly refresh: (input: Session, options: CallOptions) => Promise<ViewData>
  readonly attach: (input: Target, options: CallOptions) => Promise<ChangedData>
  readonly detach: (input: Target, options: CallOptions) => Promise<ChangedData>
  readonly events: {
    readonly on: (
      name: "updated",
      handler: (event: { readonly data: ViewData }) => void,
    ) => () => void
  }
}

/** What the client needs from the terminal: the RPC client and where each session runs. */
export interface Host {
  readonly rpc: TrackerRpc
  readonly locationOf: (sessionID: string) => Option.Option<Location>
}

/** What the RPC client throws: a failure the server declared, or one from OpenCode itself. */
const Thrown = Schema.Union([
  Schema.Struct({
    data: Schema.Struct({ message: Schema.String }),
    type: Schema.Literal("rejected"),
  }),
  Schema.Struct({ message: Schema.String, type: Schema.String }),
])

type Thrown = typeof Thrown.Type

function failureOf(thrown: Option.Option<Thrown>): RequestFailed {
  const message = Option.match(thrown, {
    onNone: () => "The pull request tracker failed.",
    onSome: (failure) => {
      if ("data" in failure) return failure.data.message

      return failure.type === "rpc.unavailable"
        ? "The pull request tracker is not running for this session's directory."
        : `The pull request tracker failed: ${failure.message}`
    },
  })

  return new RequestFailed({ message })
}

const unreadable = new RequestFailed({
  message: "The pull request tracker sent a response the terminal could not read.",
})

function decoded<S extends Schema.Decoder<unknown>>(
  schema: S,
  call: () => Promise<S["Encoded"]>,
): Effect.Effect<S["Type"], RequestFailed> {
  return Effect.tryPromise({
    catch: (error) => failureOf(Schema.decodeUnknownOption(Thrown)(error)),
    try: call,
  }).pipe(
    Effect.flatMap((output) =>
      Schema.decodeEffect(schema)(output).pipe(Effect.mapError(() => unreadable)),
    ),
  )
}

export function makeClient(host: Host): TrackerClientApi {
  const { rpc } = host

  const options = (sessionID: string): CallOptions =>
    Option.match(host.locationOf(sessionID), {
      onNone: () => ({}),
      onSome: (location) => ({ location }),
    })

  return {
    attach: (sessionID, target) =>
      decoded(Changed, async () => {
        const output = await rpc.attach({ sessionID, target }, options(sessionID))

        return output
      }),
    detach: (sessionID, target) =>
      decoded(Changed, async () => {
        const output = await rpc.detach({ sessionID, target }, options(sessionID))

        return output
      }),
    list: (sessionID) =>
      decoded(View, async () => {
        const output = await rpc.list({ sessionID }, options(sessionID))

        return output
      }),
    onUpdate: (handler) =>
      rpc.events.on("updated", ({ data }) => {
        Option.map(Schema.decodeUnknownOption(View)(data), handler)
      }),
    refresh: (sessionID) =>
      decoded(View, async () => {
        const output = await rpc.refresh({ sessionID }, options(sessionID))

        return output
      }),
  }
}
