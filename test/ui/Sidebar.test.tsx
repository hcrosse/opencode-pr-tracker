/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"

import { Option } from "effect"

import { ref, stack } from "../support/stacks.ts"
import {
  destroyMounted,
  mixed,
  entryOf,
  fresh,
  palette,
  ready,
  showSidebar,
  styled,
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

describe("Sidebar wrapping", () => {
  test("a wrapped status line continues its Stack line", async () => {
    const [first, last] = [ref("acme/platform", 1), ref("acme/platform", 3)]
    const members = stack("p", [first, ref("acme/platform", 2), last])

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

  test("shows loading until the first view arrives", async () => {
    const { lines } = await showSidebar({ _tag: "Loading" })

    expect(lines()).toEqual(["Pull requests", "", "Loading"])
  })

  test("shows a failure in red", async () => {
    const { lines, style } = await showSidebar({
      _tag: "Failed",
      message: "Saved state is unreadable",
    })

    expect(lines()).toEqual(["Pull requests", "", "Saved state is unreadable"])
    expect(style("Saved state")).toEqual(Option.some(styled(palette.tones.red)))
  })
})
