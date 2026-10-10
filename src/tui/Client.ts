/** The terminal's view of the tracker: RPC calls routed to each session's location, decoded on arrival. */
import { Data, Effect, Option, Schema } from "effect"

import { Changed, Done, View, type ViewData } from "../rpc.ts"

export class RequestFailed extends Schema.TaggedError<RequestFailed>()("RequestFailed", {
  message: Schema.String,
}) {}

export interface TrackerClientApi {
  readonly list: (sessionID: string) => Effect.Effect<View, RequestFailed>
  readonly refresh: (sessionID: string) => Effect.Effect<View, RequestFailed>
  readonly attach: (sessionID: string, target: string) => Effect.Effect<Changed, RequestFailed>
  readonly detach: (sessionID: string, target: string) => Effect.Effect<Changed, RequestFailed>
  /** Renews the session's lease, so the server keeps refreshing it. */
  readonly watch: (sessionID: string) => Effect.Effect<void, RequestFailed>
  /** Calls `handler` with each update the server publishes. Returns a function that stops the calls. */
  readonly onUpdate: (handler: (update: Update) => void) => () => void
}

/**
 * An update the server published: a session's new view, or data the terminal could not read as
 * one, with its session when that much could be read.
 */
export type Update = Data.TaggedEnum<{
  Published: { readonly view: View }
  Unreadable: { readonly sessionID: Option.Option<string> }
}>

export const Update = Data.taggedEnum<Update>()

const Addressed = Schema.Struct({ sessionID: Schema.String })

const updateOf = (data: ViewData): Update =>
  Option.match(Schema.decodeUnknownOption(View)(data), {
    onNone: () =>
      Update.Unreadable({
        sessionID: Option.map(
          Schema.decodeUnknownOption(Addressed)(data),
          (addressed) => addressed.sessionID,
        ),
      }),
    onSome: (view) => Update.Published({ view }),
  })

/** Where a session runs; RPC calls go to the plugin instance for that location. */
export interface Location {
  readonly directory: string
  readonly workspaceID?: string
}

interface CallOptions {
  readonly location?: Location
  /** Aborts the request when the call is interrupted or times out. */
  readonly signal?: AbortSignal
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
  readonly watch: (input: Session, options: CallOptions) => Promise<typeof Done.Encoded>
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
  call: (signal: AbortSignal) => Promise<S["Encoded"]>,
): Effect.Effect<S["Type"], RequestFailed> {
  return Effect.tryPromise({
    catch: (error) => failureOf(Schema.decodeUnknownOption(Thrown)(error)),
    // The parameter makes Effect create a signal, which it aborts on interruption or timeout.
    try: async (signal) => {
      const output = await call(signal)

      return output
    },
  }).pipe(
    Effect.flatMap((output) =>
      Schema.decodeEffect(schema)(output).pipe(Effect.mapError(() => unreadable)),
    ),
  )
}

/** Where to send a call about the session, and the signal that cancels it. */
const callOptions = (host: Host, sessionID: string, signal: AbortSignal): CallOptions =>
  Option.match(host.locationOf(sessionID), {
    onNone: () => ({ signal }),
    onSome: (location) => ({ location, signal }),
  })

export function makeClient(host: Host): TrackerClientApi {
  const { rpc } = host

  return {
    attach: (sessionID, target) =>
      decoded(Changed, async (signal) => {
        const output = await rpc.attach({ sessionID, target }, callOptions(host, sessionID, signal))

        return output
      }),
    detach: (sessionID, target) =>
      decoded(Changed, async (signal) => {
        const output = await rpc.detach({ sessionID, target }, callOptions(host, sessionID, signal))

        return output
      }),
    list: (sessionID) =>
      decoded(View, async (signal) => {
        const output = await rpc.list({ sessionID }, callOptions(host, sessionID, signal))

        return output
      }),
    onUpdate: (handler) =>
      rpc.events.on("updated", ({ data }) => {
        handler(updateOf(data))
      }),
    refresh: (sessionID) =>
      decoded(View, async (signal) => {
        const output = await rpc.refresh({ sessionID }, callOptions(host, sessionID, signal))

        return output
      }),
    watch: (sessionID) =>
      decoded(Done, async (signal) => {
        const output = await rpc.watch({ sessionID }, callOptions(host, sessionID, signal))

        return output
      }).pipe(Effect.asVoid),
  }
}
