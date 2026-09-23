import { describe, expect, test } from "bun:test"

import { Effect, Option, Result, Schema } from "effect"
import { constVoid } from "effect/Function"

import { View, type ViewData } from "../../src/rpc.ts"
import {
  makeClient,
  type Location,
  type TrackerClientApi,
  type TrackerRpc,
} from "../../src/tui/Client.ts"
import { bottom, entryOf, fresh, viewOf } from "../support/ui.tsx"

const listed = Schema.encodeSync(View)(viewOf([entryOf(bottom, fresh(bottom, "Bottom"))]))

/** Well-typed data that is not a view: attachment times are whole milliseconds. */
const malformed: ViewData = {
  entries: [
    {
      attachedAt: 1.5,
      membership: null,
      ref: { number: 1, owner: "acme", repository: "api" },
      status: { _tag: "Pending" },
    },
  ],
  layout: "default",
  sessionID: "ses_known",
}

/**
 * An RPC failure as the client throws it: `type`, `message`, and a declared failure's `data`. The
 * client throws plain objects; the terminal reads only these fields, so an Error carrying them stands in.
 */
const rpcFailure = (type: string, message: string): Error =>
  Object.assign(new Error(message), { type })

const rpcRefusal = (message: string): Error =>
  Object.assign(new Error("RPC method failed"), { data: { message }, type: "rejected" })

type Outcome = Result.Result<ViewData, Error>

interface Call {
  readonly method: string
  readonly location: Option.Option<Location>
}

interface FakeRpc {
  readonly rpc: TrackerRpc
  readonly calls: readonly Call[]
  readonly publish: (data: ViewData) => void
}

async function settle(outcome: Outcome): Promise<ViewData> {
  const data = await new Promise<ViewData>((resolve, reject) => {
    Result.match(outcome, { onFailure: reject, onSuccess: resolve })
  })

  return data
}

/** An RPC client that answers every call with `outcome`, recording where each call went. */
function fakeRpc(outcome: Outcome): FakeRpc {
  const calls: Call[] = []
  const handlers: ((event: { readonly data: ViewData }) => void)[] = []

  const call =
    (method: string) =>
    async (
      _input: { readonly sessionID: string },
      options: { readonly location?: Location },
    ): Promise<ViewData> => {
      calls.push({ location: Option.fromNullishOr(options.location), method })

      const output = await settle(outcome)

      return output
    }

  return {
    calls,
    publish: (data) => {
      for (const handler of handlers) handler({ data })
    },
    rpc: {
      attach: async () => ({ message: "Attached.", view: await settle(outcome) }),
      detach: async () => ({ message: "Detached.", view: await settle(outcome) }),
      events: {
        on: (_name, handler) => {
          handlers.push(handler)

          return constVoid
        },
      },
      list: call("list"),
      refresh: call("refresh"),
    },
  }
}

const here: Location = { directory: "/work/api" }

const clientOver = (fake: FakeRpc): TrackerClientApi =>
  makeClient({
    locationOf: (sessionID) => (sessionID === "ses_known" ? Option.some(here) : Option.none()),
    rpc: fake.rpc,
  })

async function failureOf(outcome: Outcome): Promise<string> {
  const failure = await Effect.runPromise(
    Effect.flip(clientOver(fakeRpc(outcome)).list("ses_known")),
  )

  return failure.message
}

describe("tracker client routing", () => {
  test("sends each call to its session's location, and a session without one to the default", async () => {
    const fake = fakeRpc(Result.succeed(listed))
    const client = clientOver(fake)

    await Effect.runPromise(Effect.all([client.list("ses_known"), client.refresh("ses_elsewhere")]))

    expect(fake.calls).toEqual([
      { location: Option.some(here), method: "list" },
      { location: Option.none(), method: "refresh" },
    ])
  })

  test("decodes views into domain values", async () => {
    const view = await Effect.runPromise(
      clientOver(fakeRpc(Result.succeed(listed))).list("ses_known"),
    )

    expect(view.entries.map((entry) => entry.ref.url)).toEqual([
      "https://github.com/acme/api/pull/1",
    ])
  })
})

describe("tracker client failures", () => {
  test("shows the message of a refusal the server declared", async () => {
    const refusal = rpcRefusal("Use the pull request URL instead.")

    expect(await failureOf(Result.fail(refusal))).toBe("Use the pull request URL instead.")
  })

  test("explains a tracker that is not running for the session's directory", async () => {
    const unavailable = rpcFailure("rpc.unavailable", "RPC is unavailable: opencode-pr-tracker")

    expect(await failureOf(Result.fail(unavailable))).toBe(
      "The pull request tracker is not running for this session's directory.",
    )
  })

  test("passes on other failures from OpenCode, and describes anything else generically", async () => {
    expect(await failureOf(Result.fail(rpcFailure("rpc.internal", "RPC call failed")))).toBe(
      "The pull request tracker failed: RPC call failed",
    )
    expect(await failureOf(Result.fail(new Error("socket closed")))).toBe(
      "The pull request tracker failed.",
    )
  })

  test("rejects a response that is not a view", async () => {
    expect(await failureOf(Result.succeed(malformed))).toBe(
      "The pull request tracker sent a response the terminal could not read.",
    )
  })
})

describe("tracker client updates", () => {
  test("delivers published views, decoded, and skips data that is not a view", () => {
    const fake = fakeRpc(Result.succeed(listed))
    const received: string[] = []

    clientOver(fake).onUpdate((view) => {
      received.push(view.entries.map((entry) => entry.ref.label).join(" "))
    })
    fake.publish(malformed)
    fake.publish(listed)

    expect(received).toEqual(["acme/api#1"])
  })
})
