import { describe, expect, test } from "bun:test"

import { Cause, type Duration, Effect, Exit, Fiber, Option, Stream } from "effect"
import { TestClock } from "effect/testing"

import { forgetDeletedSessions, type CleanupEvent } from "../../src/server/Background.ts"
import { memoryStorage, type StorageFake } from "../support/application.ts"
import { captureLogs, type Logged } from "../support/logs.ts"
import { open, run, scripted, watching, type App } from "../support/monitor.ts"

type Events = Stream.Stream<CleanupEvent, string>

interface Subscriptions {
  readonly events: Events
  readonly attempts: () => number
}

/** An event stream whose `attempt`th subscription (from 1) is `subscription(attempt)`. */
function subscriptions(subscription: (attempt: number) => Events): Subscriptions {
  let attempts = 0

  const events = Stream.suspend(() => {
    attempts += 1

    return subscription(attempts)
  })

  return { attempts: () => attempts, events }
}

const deleted = (sessionID: string): CleanupEvent => ({
  data: { sessionID },
  type: "session.deleted",
})

const created: CleanupEvent = { type: "session.created" }

const lost: Events = Stream.fail("connection lost")

const messagesAt = (lines: readonly Logged[], level: string): unknown[] =>
  lines.flatMap((line: Logged) => (line.level === level ? [line.message] : []))

const retrying =
  "Session deletion events failed; subscribing again. Sessions deleted meanwhile are not forgotten"

const stopped = "Session deletion cleanup stopped; deleted sessions are no longer forgotten"

const broken = Cause.die("broken")

/** Plugin storage in memory where removing session a dies, as a host storage failure arrives. */
function dyingRemoves(cause: Cause.Cause<never>): StorageFake {
  const memory = memoryStorage()

  return {
    storage: {
      get: (key) => memory.storage.get(key),
      remove: (key) => (key === "session/a" ? Effect.failCause(cause) : memory.storage.remove(key)),
      scan: (options) => memory.storage.scan(options),
      set: (key, value) => memory.storage.set(key, value),
    },
    values: memory.values,
    writes: () => memory.writes(),
  }
}

interface Run {
  /** How long to let cleanup run first. */
  readonly advance: Duration.Input
  /** Whether to interrupt cleanup after that, rather than wait for it to stop by itself. */
  readonly interrupt: boolean
  /** Makes removing session a from storage die. */
  readonly removeDies?: "dies" | "dies while interrupted"
}

interface Outcome {
  readonly exit: Exit.Exit<void, unknown>
  /** How many pull requests sessions a and b still have attached. */
  readonly attached: readonly number[]
  readonly lines: readonly Logged[]
}

/** Runs cleanup over `events` with sessions a and b attached, as `how` says. */
async function cleanup(events: Stream.Stream<CleanupEvent, string>, how: Run): Promise<Outcome> {
  const logs = captureLogs()

  const storage = Option.match(Option.fromNullishOr(how.removeDies), {
    onNone: () => memoryStorage(),
    onSome: (removal) =>
      dyingRemoves(removal === "dies" ? broken : Cause.combine(broken, Cause.interrupt())),
  })

  const result = await run(
    scripted(),
    (app: App) =>
      Effect.gen(function* () {
        yield* watching(app, "a", [open])
        yield* watching(app, "b", [open])

        const fiber = yield* Effect.forkChild(forgetDeletedSessions(events, app))

        yield* Effect.yieldNow
        yield* TestClock.adjust(how.advance)

        if (how.interrupt) {
          yield* Fiber.interrupt(fiber)
          // Long enough for any further subscription to show.
          yield* TestClock.adjust("1 hour")
        }

        const exit = yield* Fiber.await(fiber)
        const attached = yield* Effect.all([app.tracker.list("a"), app.tracker.list("b")])

        return { attached: attached.map((tracking) => tracking.length), exit }
      }).pipe(Effect.provide(logs.layer)),
    storage,
  )

  if (Exit.isFailure(result)) throw new Error("cleanup test setup failed")

  return { attached: result.value.attached, exit: result.value.exit, lines: logs.lines() }
}

describe("session deletion cleanup", () => {
  test("forgets only the sessions OpenCode deletes", async () => {
    const events = Stream.concat(Stream.make(created, deleted("b")), Stream.never)

    const { attached } = await cleanup(events, { advance: "0 seconds", interrupt: true })

    expect(attached).toEqual([1, 0])
  })

  test("subscribes again after the events fail and forgets sessions deleted after that", async () => {
    const source = subscriptions((attempt) =>
      attempt === 1 ? lost : Stream.concat(Stream.make(deleted("a")), Stream.never),
    )

    const { attached, lines } = await cleanup(source.events, {
      advance: "1 second",
      interrupt: true,
    })

    expect(attached).toEqual([0, 1])
    expect(source.attempts()).toBe(2)
    expect(lines.map((line: Logged) => [line.level, line.message, line.annotations])).toEqual([
      ["WARN", retrying, { attempt: 1, delayMs: 1000 }],
    ])
  })

  test("treats events that end as a failure and subscribes again", async () => {
    const source = subscriptions((attempt) => (attempt === 1 ? Stream.empty : Stream.never))

    const { lines } = await cleanup(source.events, { advance: "1 second", interrupt: true })

    expect(source.attempts()).toBe(2)
    expect(messagesAt(lines, "WARN")).toEqual([retrying])
  })
})

describe("session deletion cleanup giving up", () => {
  test("logs an error and stops after nine failures in a row", async () => {
    const source = subscriptions(() => lost)

    const { exit, lines } = await cleanup(source.events, { advance: "1 hour", interrupt: false })

    expect(Exit.isFailure(exit)).toBe(true)
    expect(source.attempts()).toBe(10)
    expect(messagesAt(lines, "WARN")).toHaveLength(9)
    expect(messagesAt(lines, "ERROR")).toEqual([stopped])
  })

  test("counts only failures since the last event toward giving up", async () => {
    // Five failures, then an event and nine failures after it: fourteen in all, never ten in a row.
    const source = subscriptions((attempt) => {
      if (attempt === 6) return Stream.concat(Stream.make(created), lost)

      return attempt <= 14 ? lost : Stream.never
    })

    const { lines } = await cleanup(source.events, { advance: "1 hour", interrupt: true })

    expect(source.attempts()).toBe(15)
    expect(messagesAt(lines, "ERROR")).toEqual([])
  })
})

describe("session deletion cleanup defects", () => {
  test("logs a defect in the events as an error without subscribing again", async () => {
    const source = subscriptions(() => Stream.die("broken"))

    const { exit, lines } = await cleanup(source.events, { advance: "1 hour", interrupt: false })

    expect(Exit.hasDies(exit)).toBe(true)
    expect(source.attempts()).toBe(1)
    expect(messagesAt(lines, "ERROR")).toEqual([stopped])
  })

  test("logs a defect while forgetting a session, with its session, and forgets later ones", async () => {
    const events = Stream.concat(Stream.make(deleted("a"), deleted("b")), Stream.never)

    const { attached, lines } = await cleanup(events, {
      advance: "0 seconds",
      interrupt: true,
      removeDies: "dies",
    })

    expect(attached).toEqual([1, 0])
    expect(
      lines.map((line: Logged) => [line.level, line.message, line.annotations["sessionID"]]),
    ).toEqual([["ERROR", "Session was not forgotten after deletion", "a"]])
  })
})

describe("session deletion cleanup interrupted", () => {
  test("stops without logging when forgetting a session is interrupted as it dies", async () => {
    const events = Stream.concat(Stream.make(deleted("a"), deleted("b")), Stream.never)

    const { attached, exit, lines } = await cleanup(events, {
      advance: "0 seconds",
      interrupt: false,
      removeDies: "dies while interrupted",
    })

    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(attached).toEqual([1, 1])
    expect(lines).toEqual([])
  })

  test("stops during a backoff without logging more or subscribing again", async () => {
    const source = subscriptions(() => lost)

    const { exit, lines } = await cleanup(source.events, { advance: "0 seconds", interrupt: true })

    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(source.attempts()).toBe(1)
    expect(messagesAt(lines, "WARN")).toEqual([retrying])
    expect(messagesAt(lines, "ERROR")).toEqual([])
  })

  test("stops without logging or subscribing again when the events fail as they are interrupted", async () => {
    const source = subscriptions(() =>
      Stream.failCause(Cause.combine(Cause.fail("connection lost"), Cause.interrupt())),
    )

    const { exit, lines } = await cleanup(source.events, { advance: "1 hour", interrupt: false })

    expect(Exit.hasInterrupts(exit)).toBe(true)
    expect(source.attempts()).toBe(1)
    expect(lines).toEqual([])
  })
})
