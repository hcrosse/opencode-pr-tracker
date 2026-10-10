/** The terminal's view of the tracker: RPC calls routed to each session's location, decoded on arrival. */
import { Data, Effect, Option, Schema } from "effect"

import { Changed, Done, RejectionReason, View, type ViewData } from "../rpc.ts"

/**
 * Why a tracker request failed, as briefly as the terminal can say: the server's reason for
 * rejecting it, a tracker not running for the session's directory, no answer in time, an answer
 * the terminal could not read, or anything else.
 */
export const FailureReason = Schema.Literals([
  ...RejectionReason.literals,
  "NotRunning",
  "TimedOut",
  "UnreadableResponse",
  "Failed",
])

export type FailureReason = typeof FailureReason.Type

export class RequestFailed extends Schema.TaggedError<RequestFailed>()("RequestFailed", {
  message: Schema.String,
  reason: FailureReason,
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
    data: Schema.Struct({ message: Schema.String, reason: Schema.optionalKey(Schema.String) }),
    type: Schema.Literal("rejected"),
  }),
  Schema.Struct({ message: Schema.String, type: Schema.String }),
])

type Thrown = typeof Thrown.Type

/** A failure the server declared, with its reason if this version knows it. */
const rejected = (data: { readonly message: string; readonly reason?: string }): RequestFailed =>
  new RequestFailed({
    message: data.message,
    reason: Option.getOrElse(
      Schema.decodeUnknownOption(RejectionReason)(data.reason),
      (): FailureReason => "Failed",
    ),
  })

function failureOf(thrown: Option.Option<Thrown>): RequestFailed {
  return Option.match(thrown, {
    onNone: () =>
      new RequestFailed({ message: "The pull request tracker failed.", reason: "Failed" }),
    onSome: (failure) => {
      if ("data" in failure) return rejected(failure.data)

      return failure.type === "rpc.unavailable"
        ? new RequestFailed({
            message: "The pull request tracker is not running for this session's directory.",
            reason: "NotRunning",
          })
        : new RequestFailed({
            message: `The pull request tracker failed: ${failure.message}`,
            reason: "Failed",
          })
    },
  })
}

const unreadable = new RequestFailed({
  message: "The pull request tracker sent a response the terminal could not read.",
  reason: "UnreadableResponse",
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
