import { describe, expect, test } from "bun:test"

import { Array as Arr, Deferred, Effect, Option } from "effect"
import { constVoid } from "effect/Function"
import { createRoot, createSignal } from "solid-js"

import type { View } from "../../src/rpc.ts"
import { RequestFailed, type TrackerClientApi } from "../../src/tui/Client.ts"
import { sessionView } from "../../src/tui/SessionSidebar.tsx"
import type { SidebarState } from "../../src/ui/Sidebar.tsx"
import { fakeTracker } from "../support/tui.ts"
import { bottom, entryOf, fresh } from "../support/ui.tsx"

const viewFor = (sessionID: string, title: string): View => ({
  entries: [entryOf(bottom, fresh(bottom, title))],
  layout: "default",
  sessionID,
})

interface HeldLists {
  readonly tracker: TrackerClientApi
  /** The answer to the `index`th listing, settled when the test chooses. */
  readonly answer: (index: number) => Deferred.Deferred<View, RequestFailed>
  readonly publish: (view: View) => void
}

/** A tracker whose listings wait until the test settles them, in any order. */
function heldLists(): HeldLists {
  const answers: Deferred.Deferred<View, RequestFailed>[] = []
  const handlers: ((view: View) => void)[] = []
  const base = fakeTracker().client

  return {
    answer: (index) => Option.getOrThrow(Arr.get(answers, index)),
    publish: (view) => {
      for (const handler of handlers) handler(view)
    },
    tracker: {
      attach: base.attach,
      detach: base.detach,
      list: () =>
        Effect.suspend(() => {
          const answer = Deferred.makeUnsafe<View, RequestFailed>()

          answers.push(answer)

          return Deferred.await(answer)
        }),
      onUpdate: (handler) => {
        handlers.push(handler)

        return constVoid
      },
      refresh: base.refresh,
    },
  }
}

/** The title shown, or the state's tag when nothing is shown. */
function titleOf(state: SidebarState): string {
  if (state._tag !== "Ready") return state._tag

  return Option.match(Arr.head(state.view.entries), {
    onNone: () => "empty",
    onSome: (entry) =>
      entry.status._tag === "Fresh" ? entry.status.snapshot.title : entry.status._tag,
  })
}

const run = (effect: Effect.Effect<void>): void => {
  Effect.runFork(effect)
}

/** Which listing to answer, and the title its answer shows. */
type Answer = readonly [index: number, title: string]

/** The first visit's listing is superseded by the third, made when the session is shown again. */
const stale: Answer = [0, "stale"]

const current: Answer = [2, "current"]

describe("sidebar view of a session", () => {
  test.each<readonly [string, Answer, Answer]>([
    ["when the session is shown again", stale, current],
    ["that arrives last", current, stale],
  ])("ignores an answer to an earlier visit %s", async (_name, first, second) => {
    const held = heldLists()
    const [session, setSession] = createSignal("a")
    const state = createRoot(() => sessionView(session, held.tracker, run))

    const settle = async ([index, title]: Answer): Promise<void> => {
      await Effect.runPromise(Deferred.succeed(held.answer(index), viewFor("a", title)))
    }

    setSession("b")
    setSession("a")
    await settle(first)
    await settle(second)

    expect(titleOf(state())).toBe("current")
  })

  test("keeps a published update over a later failure of the first listing", async () => {
    const held = heldLists()
    const [session] = createSignal("a")
    const state = createRoot(() => sessionView(session, held.tracker, run))

    held.publish(viewFor("a", "published"))
    await Effect.runPromise(
      Deferred.fail(held.answer(0), new RequestFailed({ message: "late failure" })),
    )

    expect(titleOf(state())).toBe("published")
  })
})
