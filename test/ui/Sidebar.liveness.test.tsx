/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"

import { Option } from "effect"

import { Liveness } from "../../src/ui/Sidebar.tsx"
import {
  bottom,
  destroyMounted,
  entryOf,
  fresh,
  palette,
  ready,
  showSidebar,
  styled,
  viewOf,
} from "../support/ui.tsx"

afterEach(destroyMounted)

const view = viewOf([entryOf(bottom, fresh(bottom, "Bottom"))], "compact")

describe("Sidebar heading", () => {
  test("shows nothing beside the heading while the list is live", async () => {
    const { lines } = await showSidebar(ready(view, Liveness.Live()))

    expect(lines()[0]).toBe("Pull requests")
  })

  test.each([
    ["not refreshing", Liveness.NotRefreshing()],
    ["out of date", Liveness.OutOfDate()],
  ])("marks a list that is %s in yellow and keeps its rows", async (note, liveness) => {
    const { lines, style } = await showSidebar(ready(view, liveness), { width: 36 })

    expect(lines()).toEqual([`Pull requests · ${note}`, "", "•  acme/api#1 passed"])
    expect([style(" · "), style(note)]).toEqual([
      Option.some(styled(palette.muted)),
      Option.some(styled(palette.tones.yellow)),
    ])
  })
})
