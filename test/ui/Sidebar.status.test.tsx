/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"

import { Option } from "effect"

import type { Status } from "../../src/domain/Snapshot.ts"
import {
  bottom,
  destroyMounted,
  mixed,
  second,
  entryOf,
  fresh,
  palette,
  ready,
  showSidebar,
  styled,
  viewOf,
} from "../support/ui.tsx"

afterEach(destroyMounted)

describe("Sidebar failed refreshes", () => {
  const stale: Status = {
    _tag: "Stale",
    diagnostic: "GitHubUnavailable",
    failingSince: 0,
    snapshot: { ref: bottom, state: { _tag: "Merged" }, title: "Old title" },
  }

  const unavailable: Status = { _tag: "Unavailable", diagnostic: "AuthenticationRequired" }

  test("keeps a stale status, and replaces an unavailable one with its diagnostic", async () => {
    const { lines } = await showSidebar(
      ready(viewOf([entryOf(bottom, stale), entryOf(second, unavailable)])),
    )

    expect(lines()).toEqual([
      "Pull requests",
      "",
      "•  acme/api#1 merged · stale",
      "   Old title",
      "•  acme/api#2 authenticate",
      "   Title unavailable",
    ])
  })

  test("marks a stale status in muted italics", async () => {
    const { style } = await showSidebar(ready(viewOf([entryOf(bottom, stale)])))

    expect(style("stale")).toEqual(Option.some(styled(palette.muted, { italic: true })))
  })

  test("shows a pull request that has not been fetched yet as loading", async () => {
    const { lines } = await showSidebar(ready(viewOf([entryOf(bottom, { _tag: "Pending" })])))

    expect(lines()).toEqual(["Pull requests", "", "•  acme/api#1 loading", "   Loading title"])
  })
})

describe("Sidebar status colors", () => {
  test("strikes through a merged pull request in purple, with a struck muted title", async () => {
    const view = viewOf([entryOf(bottom, fresh(bottom, "Landed", { _tag: "Merged" }))])
    const { style } = await showSidebar(ready(view))

    expect(style("acme/api#1")).toEqual(
      Option.some(styled(palette.tones.purple, { bold: true, strikethrough: true })),
    )
    expect(style("Landed")).toEqual(Option.some(styled(palette.muted, { strikethrough: true })))
  })

  test("shows an open pull request in its tone, without strikethrough", async () => {
    const { style } = await showSidebar(
      ready(viewOf([entryOf(bottom, fresh(bottom, "Checks pass"))])),
    )

    expect(style("acme/api#1")).toEqual(Option.some(styled(palette.tones.green, { bold: true })))
    expect(style(" passed")).toEqual(Option.some(styled(palette.tones.green)))
  })
})

describe("Sidebar clicks", () => {
  test("opens the pull request of a clicked row, including its title line, but not for a gap", async () => {
    const opened: string[] = []

    const { click } = await showSidebar(ready(viewOf(mixed)), {
      onOpen: (pullRequest) => {
        opened.push(pullRequest.label)
      },
      width: 36,
    })

    await click(5, 2)
    await click(5, 5)
    await click(5, 6)

    expect(opened).toEqual(["acme/web#9", "acme/api#1"])
  })
})
