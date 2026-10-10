import { Deferred, Effect } from "effect"
import { createRoot, createSignal, type Accessor } from "solid-js"
import { vi } from "vitest"

import type { View } from "../../src/rpc.ts"
import { background } from "../../src/tui/Background.ts"
import { RequestFailed, type TrackerClientApi, type Update } from "../../src/tui/Client.ts"
import { sessionView } from "../../src/tui/SessionView.ts"
import { Liveness, SidebarState } from "../../src/ui/Sidebar.tsx"
import { fakeTracker } from "./tui.ts"
import { bottom, entryOf, fresh } from "./ui.tsx"

const { run } = background()

export const viewTitled = (title: string): View => ({
  entries: [entryOf(bottom, fresh(bottom, title))],
  layout: "full",
  sessionID: "a",
})

type Renewal = "answer" | "fail" | "die"

type Answer =
  | { readonly title: string }
  | { readonly failure: string }
  | { readonly defect: string }

const settled = (
  deferred: Deferred.Deferred<View, RequestFailed>,
  answer: Answer,
): Effect.Effect<boolean> => {
  if ("title" in answer) return Deferred.succeed(deferred, viewTitled(answer.title))

  if ("failure" in answer)
    return Deferred.fail(deferred, new RequestFailed({ message: answer.failure, reason: "Failed" }))

  return Deferred.die(deferred, answer.defect)
}

/** Listings of session `a` that answer with a view titled `first`, or wait until settled. */
interface HeldListings {
  readonly list: TrackerClientApi["list"]
  /** Makes later listings wait for `settle`. */
  readonly holdLists: () => void
  /** Answers the oldest held listing with a view titled `title`, fails it, or kills it with a defect. */
  readonly settle: (answer: Answer) => void
}

function heldListings(first: string, base: TrackerClientApi): HeldListings {
  const held: Deferred.Deferred<View, RequestFailed>[] = []
  let holding = false

  return {
    holdLists: () => {
      holding = true
    },
    list: (sessionID) =>
      Effect.andThen(base.list(sessionID), () => {
        if (!holding) return Effect.succeed(viewTitled(first))

        const answer = Deferred.makeUnsafe<View, RequestFailed>()

        held.push(answer)

        return Deferred.await(answer)
      }),
    settle: (answer) => {
      for (const deferred of held.splice(0, 1)) Effect.runSync(settled(deferred, answer))

      // The listing resumes on Effect's scheduler, which the fake timers run a millisecond later.
      vi.advanceTimersByTime(1)
    },
  }
}

/** How tests drive a tracker whose renewals, listings and published updates they control. */
export interface Script extends Omit<HeldListings, "list"> {
  readonly client: TrackerClientApi
  readonly calls: readonly string[]
  /** Makes later renewals answer, fail, or die with a defect. */
  readonly renewals: (outcome: Renewal) => void
  readonly publish: (update: Update) => void
}

export function scripted(first: string): Script {
  const { calls, client } = fakeTracker()
  const listings = heldListings(first, client)
  const handlers = new Set<(update: Update) => void>()
  let renewal: Renewal = "answer"

  return {
    calls,
    client: {
      attach: client.attach,
      detach: client.detach,
      list: listings.list,
      onUpdate: (handler) => {
        handlers.add(handler)

        return () => {
          handlers.delete(handler)
        }
      },
      refresh: client.refresh,
      watch: (sessionID) =>
        Effect.andThen(client.watch(sessionID), () => {
          if (renewal === "fail")
            return Effect.fail(new RequestFailed({ message: "unreachable", reason: "Failed" }))

          return renewal === "die" ? Effect.die("renewal defect") : Effect.void
        }),
    },
    holdLists: listings.holdLists,
    publish: (update) => {
      for (const handler of handlers) handler(update)
    },
    renewals: (outcome) => {
      renewal = outcome
    },
    settle: listings.settle,
  }
}

const livenessOf = (liveness: Liveness): string =>
  Liveness.$match(liveness, {
    Live: () => "live",
    Stale: () => "stale",
  })

/** What the sidebar shows: its liveness and titles, or the state it is in instead. */
const shownOf = (state: SidebarState): string =>
  SidebarState.$match(state, {
    Failed: ({ message, reason }) => `failed (${reason}): ${message}`,
    Loading: () => "loading",
    Ready: ({ liveness, view }) => {
      const titles = view.entries.map((entry) =>
        "snapshot" in entry.status ? entry.status.snapshot.title : "",
      )

      return `${livenessOf(liveness)}: ${titles.join(", ")}`
    },
  })

/**
 * Shows session `a` under Vitest's fake timers, which also drive Effect's clock, and unmounts it
 * after `body`. `shown` describes what the sidebar shows, as `liveness: titles`.
 */
export function showing(script: Script, body: (shown: () => string) => void): void {
  vi.useFakeTimers()

  const [session] = createSignal("a")

  const [state, dispose] = createRoot((stop): readonly [Accessor<SidebarState>, () => void] => [
    sessionView(session, script.client, run),
    stop,
  ])

  try {
    body(() => shownOf(state()))
  } finally {
    dispose()
    vi.useRealTimers()
  }
}
