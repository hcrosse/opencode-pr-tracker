import { describe, expect, jest, test } from "bun:test"

import { Effect } from "effect"
import { createRoot, createSignal, type Accessor } from "solid-js"

import { background } from "../../src/tui/Background.ts"
import type { TrackerClientApi } from "../../src/tui/Client.ts"
import { sessionView } from "../../src/tui/SessionSidebar.tsx"
import { fakeTracker } from "../support/tui.ts"

const { run } = background()

interface HeldWatches {
  readonly client: TrackerClientApi
  readonly calls: readonly string[]
  /** Renewals started and not yet ended, whether by timing out or being interrupted. */
  readonly inFlight: () => number
  /** The most renewals in flight at once. */
  readonly peak: () => number
}

/** A tracker whose renewals never answer, recording how many are in flight. */
function heldWatches(): HeldWatches {
  const { calls, client } = fakeTracker()
  let inFlight = 0
  let peak = 0

  const hold = Effect.suspend(() => {
    inFlight += 1
    peak = Math.max(peak, inFlight)

    return Effect.ensuring(
      Effect.never,
      Effect.sync(() => {
        inFlight -= 1
      }),
    )
  })

  return {
    calls,
    client: {
      attach: client.attach,
      detach: client.detach,
      list: client.list,
      onUpdate: client.onUpdate,
      refresh: client.refresh,
      watch: (sessionID) => Effect.andThen(client.watch(sessionID), hold),
    },
    inFlight: () => inFlight,
    peak: () => peak,
  }
}

/** Runs the test with Bun's fake timers, which also drive Effect's default clock. */
function withFakeTimers(body: () => void): void {
  jest.useFakeTimers()

  try {
    body()
  } finally {
    jest.useRealTimers()
  }
}

/** Shows the sidebar for the signalled session, returning how to unmount it. */
function show(session: Accessor<string>, tracker: TrackerClientApi): () => void {
  return createRoot((dispose) => {
    sessionView(session, tracker, run)

    return dispose
  })
}

describe("sidebar lease renewal", () => {
  test("renews the shown session's lease every 15 seconds until it switches or unmounts", () => {
    const tracker = fakeTracker()
    const [session, setSession] = createSignal("a")

    withFakeTimers(() => {
      const dispose = show(session, tracker.client)

      jest.advanceTimersByTime(30_000)
      setSession("b")
      jest.advanceTimersByTime(15_000)
      dispose()
      jest.advanceTimersByTime(15_000)
    })

    expect(tracker.calls).toEqual(["list a", "watch a", "watch a", "list b", "watch b"])
  })

  test("keeps renewing after a renewal fails", () => {
    const tracker = fakeTracker()

    withFakeTimers(() => {
      const dispose = show(() => "a", tracker.client)

      tracker.fail("server unreachable")
      jest.advanceTimersByTime(30_000)
      dispose()
    })

    expect(tracker.calls).toEqual(["list a", "watch a", "watch a"])
  })
})

describe("sidebar lease renewal against a slow server", () => {
  test("gives up on a renewal after 5 seconds and renews again at the next interval", () => {
    const held = heldWatches()
    const seen: (readonly [calls: number, inFlight: number])[] = []

    const look = (): void => {
      seen.push([held.calls.length, held.inFlight()])
    }

    withFakeTimers(() => {
      const dispose = show(() => "a", held.client)

      jest.advanceTimersByTime(19_999)
      look()
      jest.advanceTimersByTime(1)
      look()
      jest.advanceTimersByTime(10_000)
      look()
      dispose()
    })

    expect(seen).toEqual([
      [2, 1],
      [2, 0],
      [3, 1],
    ])
  })
})

describe("sidebar lease renewal cadence", () => {
  test("keeps a 15-second cadence without overlapping renewals", () => {
    const held = heldWatches()

    withFakeTimers(() => {
      const dispose = show(() => "a", held.client)

      jest.advanceTimersByTime(60_000)
      dispose()
    })

    expect([held.calls, held.peak()]).toEqual([
      ["list a", "watch a", "watch a", "watch a", "watch a"],
      1,
    ])
  })
})

describe("sidebar lease renewal when the shown session changes", () => {
  test("stops a renewal in flight and renews the next session one interval later", () => {
    const held = heldWatches()
    const [session, setSession] = createSignal("a")
    const seen: (readonly [calls: readonly string[], inFlight: number])[] = []

    const look = (): void => {
      seen.push([[...held.calls], held.inFlight()])
    }

    withFakeTimers(() => {
      const dispose = show(session, held.client)

      jest.advanceTimersByTime(15_000)
      // Interruption finishes on Effect's scheduler, which the fake timers run a millisecond later.
      setSession("b")
      jest.advanceTimersByTime(1)
      look()
      jest.advanceTimersByTime(14_998)
      look()
      jest.advanceTimersByTime(1)
      look()
      dispose()
      jest.advanceTimersByTime(1)
      look()
    })

    expect(seen).toEqual([
      [["list a", "watch a", "list b"], 0],
      [["list a", "watch a", "list b"], 0],
      [["list a", "watch a", "list b", "watch b"], 1],
      [["list a", "watch a", "list b", "watch b"], 0],
    ])
  })
})
