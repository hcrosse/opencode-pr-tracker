import { describe, expect, jest, test } from "bun:test"

import { Option, Schema } from "effect"
import { constVoid } from "effect/Function"
import { createRoot, createSignal, type Accessor } from "solid-js"

import { View } from "../../src/rpc.ts"
import { background } from "../../src/tui/Background.ts"
import { trackerClient, type TrackerClientApi, type TrackerRpc } from "../../src/tui/Client.ts"
import { sessionView } from "../../src/tui/SessionView.ts"
import { fakeTracker } from "../support/tui.ts"
import { viewOf } from "../support/ui.tsx"

const { run } = background()

interface HeldWatches {
  readonly client: TrackerClientApi
  readonly calls: readonly string[]
  /** Renewal RPCs neither answered nor aborted. */
  readonly pending: () => number
  /** The most renewal RPCs pending at once. */
  readonly peak: () => number
  readonly aborted: () => number
}

const unexpected = async (): Promise<never> => {
  const output = await Promise.reject(new Error("unexpected call"))

  return output
}

interface Holds {
  /** Never answers; rejects once `signal` aborts. */
  readonly hold: (signal: AbortSignal | undefined) => Promise<never>
  readonly pending: () => number
  readonly peak: () => number
  readonly aborted: () => number
}

/** Requests that end only when aborted, counted as they start and end. */
function abortableHolds(): Holds {
  let pending = 0
  let peak = 0
  let aborted = 0

  const hold = async (signal: AbortSignal | undefined): Promise<never> => {
    pending += 1
    peak = Math.max(peak, pending)

    const output = await new Promise<never>((_resolve, reject) => {
      Option.map(Option.fromNullishOr(signal), (aborting) => {
        aborting.addEventListener("abort", () => {
          pending -= 1
          aborted += 1
          reject(new Error("aborted"))
        })
      })
    })

    return output
  }

  return { aborted: () => aborted, hold, peak: () => peak, pending: () => pending }
}

/** The real client over an RPC whose renewals never answer and end only when aborted. */
function heldWatches(): HeldWatches {
  const calls: string[] = []
  const listed = Schema.encodeSync(View)(viewOf([]))
  const holds = abortableHolds()

  const rpc: TrackerRpc = {
    attach: unexpected,
    detach: unexpected,
    events: { on: () => constVoid },
    list: async ({ sessionID }) => {
      calls.push(`list ${sessionID}`)

      const output = await Promise.resolve(listed)

      return output
    },
    refresh: unexpected,
    watch: async ({ sessionID }, { signal }) => {
      calls.push(`watch ${sessionID}`)

      const output = await holds.hold(signal)

      return output
    },
  }

  return {
    aborted: holds.aborted,
    calls,
    client: trackerClient({ locationOf: () => Option.none(), rpc }),
    peak: holds.peak,
    pending: holds.pending,
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
  test("aborts a renewal after 5 seconds and renews again at the next interval", () => {
    const held = heldWatches()
    const seen: (readonly [calls: number, pending: number, aborted: number])[] = []

    const look = (): void => {
      seen.push([held.calls.length, held.pending(), held.aborted()])
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
      [2, 1, 0],
      [2, 0, 1],
      [3, 1, 1],
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
      jest.advanceTimersByTime(1)
    })

    expect([held.calls, held.peak(), held.aborted()]).toEqual([
      ["list a", "watch a", "watch a", "watch a", "watch a"],
      1,
      4,
    ])
  })
})

describe("sidebar lease renewal when the shown session changes", () => {
  test("aborts a renewal in flight and renews the next session one interval later", () => {
    const held = heldWatches()
    const [session, setSession] = createSignal("a")
    const seen: (readonly [calls: readonly string[], pending: number, aborted: number])[] = []

    const look = (): void => {
      seen.push([[...held.calls], held.pending(), held.aborted()])
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
      [["list a", "watch a", "list b"], 0, 1],
      [["list a", "watch a", "list b"], 0, 1],
      [["list a", "watch a", "list b", "watch b"], 1, 1],
      [["list a", "watch a", "list b", "watch b"], 0, 2],
    ])
  })
})
