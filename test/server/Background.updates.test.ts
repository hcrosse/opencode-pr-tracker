import { describe, expect, test } from "bun:test"

import { Cause, Effect, Exit, Schema, Stream } from "effect"

import type { SessionView } from "../../src/application/Monitor.ts"
import { sentView, View, type ViewData } from "../../src/rpc.ts"
import { sendUpdates } from "../../src/server/Background.ts"
import { captureLogs, type Logged } from "../support/logs.ts"
import { bottom, entryOf, fresh, viewOf } from "../support/ui.tsx"

const views = Stream.make<readonly SessionView[]>(
  { entries: [], sessionID: "a" },
  { entries: [], sessionID: "b" },
)

/** Sends `views` through `emit`, returning the exit, the logs, and the sessions sent. */
async function send(emit: (view: SessionView) => Effect.Effect<void, string>): Promise<{
  readonly exit: Exit.Exit<void, unknown>
  readonly lines: readonly (readonly unknown[])[]
}> {
  const logs = captureLogs()

  const exit = await Effect.runPromise(
    Effect.exit(sendUpdates(views, (view) => Effect.succeed(view), emit)).pipe(
      Effect.provide(logs.layer),
    ),
  )

  return {
    exit,
    lines: logs
      .lines()
      .map((line: Logged) => [line.level, line.message, line.annotations["sessionID"] ?? null]),
  }
}

describe("update events", () => {
  test("logs each update it could not send, with its session", async () => {
    const sent: string[] = []

    const { lines } = await send((view) =>
      view.sessionID === "a"
        ? Effect.fail("closed")
        : Effect.sync(() => {
            sent.push(view.sessionID)
          }),
    )

    expect(sent).toEqual(["b"])
    expect(lines).toEqual([["WARN", "Pull request update was not sent", "a"]])
  })

  test("logs a defect while sending an update, with its session, and sends later ones", async () => {
    const sent: string[] = []

    const { exit, lines } = await send((view) =>
      view.sessionID === "a"
        ? Effect.die("broken")
        : Effect.sync(() => {
            sent.push(view.sessionID)
          }),
    )

    expect(exit).toEqual(Exit.void)
    expect(sent).toEqual(["b"])
    expect(lines).toEqual([["ERROR", "Pull request update was not sent", "a"]])
  })
})

describe("update events interrupted", () => {
  test("stops without logging when sending is interrupted as it fails", async () => {
    const sent: string[] = []

    const { exit, lines } = await send((view) =>
      view.sessionID === "a"
        ? Effect.failCause(Cause.combine(Cause.fail("closed"), Cause.interrupt()))
        : Effect.sync(() => {
            sent.push(view.sessionID)
          }),
    )

    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(sent).toEqual([])
    expect(lines).toEqual([])
  })
})

describe("update events that cannot be encoded", () => {
  test("skips a view that cannot be encoded, logging its session, and sends the next", async () => {
    const logs = captureLogs()
    const sent: ViewData[] = []
    const good = viewOf([entryOf(bottom, fresh(bottom, "Bottom"))])

    // Attachment times are whole milliseconds, so this view cannot be encoded.
    const broken = Object.assign(
      {},
      viewOf([Object.assign({}, entryOf(bottom, fresh(bottom, "Bottom")), { attachedAt: 1.5 })]),
      { sessionID: "ses_broken" },
    )

    const exit = await Effect.runPromise(
      Effect.exit(
        sendUpdates(Stream.make(broken, good), Schema.encodeEffect(View), (data: ViewData) =>
          Effect.sync(() => {
            sent.push(data)
          }),
        ),
      ).pipe(Effect.provide(logs.layer)),
    )

    expect(exit).toEqual(Exit.void)
    expect(sent).toEqual([sentView(good)])
    expect(
      logs.lines().map((line: Logged) => [line.level, line.message, line.annotations["sessionID"]]),
    ).toEqual([
      ["ERROR", "A session view could not be encoded, so it was not published", "ses_broken"],
    ])
  })
})
