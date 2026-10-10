import { Option } from "effect"
import { afterEach, describe, expect, test } from "vitest"

import type { FailureReason } from "../../src/tui/Client.ts"
import { Liveness, SidebarState } from "../../src/ui/Sidebar.tsx"
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

describe("Sidebar heading for listed pull requests", () => {
  test("shows nothing beside the heading while the list is live", async () => {
    const { lines } = await showSidebar(ready(view, Liveness.Live()))

    expect(lines()).toEqual(["Pull requests", "", "•  acme/api#1 passed"])
  })

  test("marks a stale list in the warning color and keeps its rows", async () => {
    const { lines, style } = await showSidebar(ready(view, Liveness.Stale()), { width: 36 })

    expect(lines()).toEqual(["Pull requests · stale", "", "•  acme/api#1 passed"])
    expect([style(" · "), style("stale")]).toEqual([
      Option.some(styled(palette.muted)),
      Option.some(styled(palette.tones.yellow)),
    ])
  })

  test("shows loading in muted color, with nothing under the heading", async () => {
    const { lines, style } = await showSidebar(SidebarState.Loading())

    expect(lines()).toEqual(["Pull requests · loading"])
    expect(style("loading")).toEqual(Option.some(styled(palette.muted)))
  })
})

describe("Sidebar heading for a failed first listing", () => {
  test.each<readonly [FailureReason, string]>([
    ["NotRunning", "not running"],
    ["TimedOut", "timed out"],
    ["StoredStateInvalid", "unreadable state"],
    ["AuthenticationRequired", "sign in needed"],
    ["GitHubCliMissing", "gh missing"],
    ["RateLimited", "rate limited"],
    ["GitHubUnavailable", "GitHub unavailable"],
    ["NotFound", "not found"],
    ["InvalidResponse", "bad response"],
    ["UnreadableResponse", "unreadable response"],
    ["Failed", "failed"],
  ])("names %s as %s", async (reason, note) => {
    const { lines } = await showSidebar(SidebarState.Failed({ message: "Why.", reason }))

    expect(lines()).toEqual([`Pull requests · ${note}`, "", "Why."])
  })

  test("shows the short cause in the warning color and the full reason muted", async () => {
    const message = "The pull request tracker is not running for this session's directory."

    const { lines, style } = await showSidebar(
      SidebarState.Failed({ message, reason: "NotRunning" }),
    )

    expect(lines()).toEqual([
      "Pull requests · not running",
      "",
      "The pull request tracker is not running for",
      "this session's directory.",
    ])
    expect([style("not running"), style("The pull request")]).toEqual([
      Option.some(styled(palette.tones.yellow)),
      Option.some(styled(palette.muted)),
    ])
  })
})
