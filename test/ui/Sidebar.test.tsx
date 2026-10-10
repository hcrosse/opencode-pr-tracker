import { afterEach, describe, expect, test } from "vitest"

import { Membership } from "../../src/domain/StackLayout.ts"
import { ref } from "../support/stacks.ts"
import {
  destroyMounted,
  mixed,
  entryOf,
  fresh,
  ready,
  showSidebar,
  viewOf,
} from "../support/ui.tsx"

afterEach(destroyMounted)

describe("Sidebar layouts", () => {
  test("shows titles under each row, with Stack markers, a gap, and wrapped titles kept on the line", async () => {
    const { lines } = await showSidebar(ready(viewOf(mixed)), { width: 36 })

    expect(lines()).toEqual([
      "▼ Pull requests",
      "",
      "•  acme/web#9 passed",
      "   Standalone change",
      "┌─ acme/api#1 passed",
      "│  Bottom of the Stack",
      "├┄ 1 PR not attached",
      "├─ acme/api#3 passed",
      "┊  A long title that will certainly",
      "┊  wrap onto another line",
    ])
  })

  test("the compact layout shows one row per pull request, and gaps, without titles", async () => {
    const { lines } = await showSidebar(ready(viewOf(mixed, "compact")), { width: 36 })

    expect(lines()).toEqual([
      "▼ Pull requests",
      "",
      "•  acme/web#9 passed",
      "┌─ acme/api#1 passed",
      "├┄ 1 PR not attached",
      "├─ acme/api#3 passed",
    ])
  })
})

const lower = [ref("acme/api", 1), ref("acme/api", 2), ref("acme/api", 3)] as const

const upper = [ref("acme/web", 1), ref("acme/web", 2), ref("acme/web", 3)] as const

const touching = [
  entryOf(
    lower[0],
    fresh(lower[0], "Base A"),
    Membership.cases.Stack.make({ id: "a", members: lower }),
  ),
  entryOf(
    lower[1],
    fresh(lower[1], "Middle A"),
    Membership.cases.Stack.make({ id: "a", members: lower }),
  ),
  entryOf(
    upper[1],
    fresh(upper[1], "Middle B"),
    Membership.cases.Stack.make({ id: "b", members: upper }),
  ),
  entryOf(
    upper[2],
    fresh(upper[2], "Head B"),
    Membership.cases.Stack.make({ id: "b", members: upper }),
  ),
]

describe("Sidebar Stack boundaries", () => {
  test("closes partial Stacks where they touch, without adding rows", async () => {
    const { lines } = await showSidebar(ready(viewOf(touching, "compact")), { width: 36 })

    expect(lines()).toEqual([
      "▼ Pull requests",
      "",
      "┌─ acme/api#1 passed",
      "╰─ acme/api#2 passed",
      "╭─ acme/web#2 passed",
      "└─ acme/web#3 passed",
    ])
  })

  test("keeps the open connector under a closed edge in the full layout", async () => {
    const { lines } = await showSidebar(ready(viewOf(touching.slice(1, 3))), { width: 36 })

    expect(lines()).toEqual([
      "Pull requests",
      "",
      "╶─ acme/api#2 passed",
      "┊  Middle A",
      "╶─ acme/web#2 passed",
      "┊  Middle B",
    ])
  })
})

describe("Sidebar wrapping", () => {
  test("a wrapped status line continues its Stack line", async () => {
    const [first, last] = [ref("acme/platform", 1), ref("acme/platform", 3)]

    const members = Membership.cases.Stack.make({
      id: "p",
      members: [first, ref("acme/platform", 2), last],
    })

    const view = viewOf(
      [entryOf(first, fresh(first, "First"), members), entryOf(last, fresh(last, "Last"), members)],
      "compact",
    )

    const { lines } = await showSidebar(ready(view), { width: 22 })

    expect(lines()).toEqual([
      "Pull requests",
      "",
      "┌─ acme/platform#1",
      "│  passed",
      "├┄ 1 PR not attached",
      "└─ acme/platform#3",
      "   passed",
    ])
  })
})

describe("Sidebar heading", () => {
  test("cannot collapse two pull requests", async () => {
    let toggles = 0

    const { click, lines } = await showSidebar(ready(viewOf(mixed.slice(0, 2), "compact")), {
      collapsed: true,
      onToggle: () => {
        toggles += 1
      },
    })

    await click(4, 0)

    expect(toggles).toBe(0)

    // The lone attached member of a larger Stack uses the incomplete marker.
    expect(lines()).toEqual(["Pull requests", "", "•  acme/web#9 passed", "├─ acme/api#1 passed"])
  })

  test("collapses more than two pull requests to the heading", async () => {
    const { lines } = await showSidebar(ready(viewOf(mixed)), { collapsed: true })

    expect(lines()).toEqual(["▶ Pull requests"])
  })

  test("toggles when the heading is clicked, and only then", async () => {
    let toggles = 0

    const { click } = await showSidebar(ready(viewOf(mixed)), {
      onToggle: () => {
        toggles += 1
      },
    })

    await click(4, 2)
    await click(4, 0)

    expect(toggles).toBe(1)
  })
})

describe("Sidebar states", () => {
  test("shows a message when nothing is attached", async () => {
    const { lines } = await showSidebar(ready(viewOf([])))

    expect(lines()).toEqual(["Pull requests", "", "No pull requests attached"])
  })
})
