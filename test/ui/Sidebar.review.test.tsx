/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"

import { Option } from "effect"

import { failed, type Status } from "../../src/domain/Snapshot.ts"
import type { Layout } from "../../src/rpc.ts"
import { reviewExamples, reviewWith } from "../support/reviews.ts"
import { ref } from "../support/stacks.ts"
import {
  destroyMounted,
  entryOf,
  fresh,
  palette,
  ready,
  type Rendered,
  showSidebar,
  styled,
  viewOf,
} from "../support/ui.tsx"

afterEach(destroyMounted)

const pullRequest = ref("acme/api", 13)

const changes = fresh(pullRequest, "Migrate sessions table", {
  _tag: "Open",
  behind: false,
  ci: "pending",
  draft: false,
  mergeability: "mergeable",
  review: reviewWith("changesRequested", [2, 1]),
})

async function show(status: Status, layout: Layout, width = 70): Promise<Rendered> {
  const rendered = await showSidebar(ready(viewOf([entryOf(pullRequest, status)], layout)), {
    width,
  })

  return rendered
}

const line = "•  acme/api#13 pending · changes · 2 unreplied · 1 replied"

describe("Sidebar review state layout", () => {
  test("follows the status in both layouts", async () => {
    const full = await show(changes, "default")
    const compact = await show(changes, "compact")

    expect(full.lines()).toEqual(["Pull requests", "", line, "   Migrate sessions table"])
    expect(compact.lines()).toEqual(["Pull requests", "", line])
  })

  test("keeps the last known review state while a refresh fails, before the stale marker", async () => {
    const { lines } = await show(failed(changes, "GitHubUnavailable", 0), "compact")

    expect(lines()).toEqual(["Pull requests", "", `${line} · stale`])
  })

  test("wraps a long review state under the marker column", async () => {
    const { lines } = await show(changes, "compact", 36)

    expect(lines()).toEqual([
      "Pull requests",
      "",
      "•  acme/api#13 pending · changes · 2",
      "   unreplied · 1 replied",
    ])
  })
})

describe("Sidebar review state colors", () => {
  test("colors each part by its tone, with muted separators, leaving the status color alone", async () => {
    const { style } = await show(changes, "default")

    expect(style(" pending")).toEqual(Option.some(styled(palette.tones.yellow)))
    expect(style(" · ")).toEqual(Option.some(styled(palette.muted)))
    expect(style("changes")).toEqual(Option.some(styled(palette.tones.yellow)))
    expect(style("2 unreplied")).toEqual(Option.some(styled(palette.tones.yellow)))
    expect(style("1 replied")).toEqual(Option.some(styled(palette.tones.gray)))
  })

  test("shows an approval in green on a failing pull request, which stays red", async () => {
    const example = reviewExamples.find((candidate) => candidate.number === 40)
    const state = Option.getOrThrow(Option.fromNullishOr(example)).state
    const { lines, style } = await show(fresh(pullRequest, "Client wiring", state), "compact")

    expect(lines()).toEqual(["Pull requests", "", "•  acme/api#13 failed · approved · 3 unreplied"])
    expect(style(" failed")).toEqual(Option.some(styled(palette.tones.red)))
    expect(style("approved")).toEqual(Option.some(styled(palette.tones.green)))
  })
})
