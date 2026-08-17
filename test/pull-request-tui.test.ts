import { describe, expect, test } from "bun:test"

import { RGBA, TextAttributes } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { jsx } from "@opentui/solid/jsx-runtime"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

import {
  attachPullRequest,
  createPullRequestCommands,
  createRefreshBus,
  PullRequestSidebar,
  type PullRequestSidebarLayout,
  type PullRequestTuiDependencies,
  type RefreshBus,
} from "../src/pull-request-tui.js"
import type { GitHubClient, ProcessRunner, PullRequestStackMembership, PullRequestState } from "../src/github.js"
import type { PullRequestAttachment, StateStore } from "../src/state.js"
import { parsePullRequestUrl, type PullRequestUrl } from "../src/url.js"
import { attachment, available, githubStatuses, pullRequest, secondAttachment, stateStore } from "./tui-fixtures.js"

const thirdParsed = parsePullRequestUrl("https://github.com/third/example/pull/9")
if (!thirdParsed.ok) throw new Error("third test fixture URL is invalid")
const thirdAttachment: PullRequestAttachment = {
  pullRequest: thirdParsed.value,
  attachedAt: "2026-08-10T12:02:00.000Z",
}

function stackMembership(id: string, members: readonly PullRequestUrl[]): PullRequestStackMembership {
  const [first, ...rest] = members
  if (first === undefined) throw new Error("Stack test fixture is empty")
  return { tag: "Stack", id, members: [first, ...rest] }
}

function isStruck(attributes: number): boolean {
  return (attributes & TextAttributes.STRIKETHROUGH) === TextAttributes.STRIKETHROUGH
}

function registerPullRequestCommands(
  api: TuiPluginApi,
  input: PullRequestTuiDependencies & Readonly<{ refreshBus?: RefreshBus }>,
): void {
  const { refreshBus = createRefreshBus(), ...dependencies } = input
  api.keymap.registerLayer({ commands: [...createPullRequestCommands(api, dependencies, refreshBus)], bindings: [] })
}

async function renderSidebar(
  items: readonly PullRequestAttachment[],
  options: Readonly<{
    followingText?: string
    github?: GitHubClient
    layout?: PullRequestSidebarLayout
    memberships?: readonly PullRequestStackMembership[]
    runner?: ProcessRunner
    width?: number
  }> = {},
) {
  let githubCalls = 0
  const colors = {
    text: RGBA.fromHex("#ffffff"),
    textMuted: RGBA.fromHex("#777777"),
    error: RGBA.fromHex("#ff0000"),
    warning: RGBA.fromHex("#ffff00"),
    success: RGBA.fromHex("#00ff00"),
    secondary: RGBA.fromHex("#ff00ff"),
  }
  const github = options.github ?? githubStatuses()
  const refreshBus = createRefreshBus()
  const api = {
    lifecycle: {
      signal: new AbortController().signal,
    },
    theme: {
      current: {
        ...colors,
      },
    },
    ui: { toast() {} },
  } as unknown as TuiPluginApi
  const dependencies = {
    store: stateStore(items),
    github: {
      async getStack(requested) {
        return { ok: true, value: [requested] }
      },
      async getStacks(requested) {
        return {
          ok: true,
          value: requested.map((value, index) => ({
            ok: true,
            value: options.memberships?.[index] ?? { tag: "Standalone", pullRequest: value },
          })),
        }
      },
      async get(...args) {
        githubCalls += 1
        return github.get(...args)
      },
    },
    ...(options.runner ? { runner: options.runner } : {}),
  } satisfies PullRequestTuiDependencies

  const view = await testRender(
    () =>
      jsx("box", {
        flexDirection: "column",
        children: [
          PullRequestSidebar({
            api,
            sessionID: "session",
            dependencies,
            refreshBus,
            updates: { current: () => undefined, subscribe: () => () => undefined },
            layout: options.layout ?? "default",
          }),
          options.followingText ? jsx("text", { children: options.followingText }) : null,
        ],
      }),
    { width: options.width ?? 80, height: 20 },
  )
  await view.waitForFrame((frame) => frame.includes("Pull requests"))
  if (items.length > 0) await view.waitFor(() => githubCalls === 1)
  await view.renderOnce()

  return {
    view,
    colors,
    emitSessionUpdated() {
      refreshBus.emit("session")
    },
    githubCalls: () => githubCalls,
    async cleanup() {
      view.renderer.destroy()
    },
  }
}

describe("pull request TUI", () => {
  test("collapses more than two pull requests without stopping refreshes", async () => {
    const sidebar = await renderSidebar([attachment, secondAttachment, thirdAttachment])
    try {
      const openFrame = await sidebar.view.waitForFrame(
        (frame) => frame.includes("▼ Pull requests") && frame.includes("owner/repository#42"),
      )
      expect(openFrame).toContain("third/example#9")

      await sidebar.view.mockMouse.pressDown(1, 0)
      await sidebar.view.flush()
      const collapsedFrame = sidebar.view.captureCharFrame()
      expect(collapsedFrame).toContain("▶ Pull requests")
      expect(collapsedFrame).not.toContain("owner/repository#42")

      await sidebar.view.waitFor(() => sidebar.githubCalls() === 1)
      sidebar.emitSessionUpdated()
      await sidebar.view.waitFor(() => sidebar.githubCalls() === 2)

      await sidebar.view.mockMouse.pressDown(1, 0)
      await sidebar.view.flush()
      expect(sidebar.view.captureCharFrame()).toContain("owner/repository#42")
    } finally {
      await sidebar.cleanup()
    }
  })

  test("keeps two pull requests expanded without a disclosure control", async () => {
    const sidebar = await renderSidebar([attachment, secondAttachment])
    try {
      const frame = await sidebar.view.waitForFrame(
        (value) => value.includes("Pull requests") && value.includes("owner/repository#42"),
      )
      expect(frame).not.toContain("▼ Pull requests")
      expect(frame).not.toContain("▶ Pull requests")

      await sidebar.view.mockMouse.pressDown(1, 0)
      await sidebar.view.flush()
      expect(sidebar.view.captureCharFrame()).toContain("owner/repository#42")
    } finally {
      await sidebar.cleanup()
    }
  })

  test("renders consecutive pull request entries without a blank row", async () => {
    const sidebar = await renderSidebar([attachment, secondAttachment])
    try {
      const frame = await sidebar.view.waitForFrame(
        (value) => value.includes("owner/repository#42") && value.includes("another/project#7"),
      )
      const rows = frame.split("\n")
      const firstEntryRow = rows.findIndex((row) => row.includes("owner/repository#42"))
      const firstReference = rows[firstEntryRow]!
      const firstTitle = rows[firstEntryRow + 1]!
      const secondReference = rows[firstEntryRow + 2]!
      const secondTitle = rows[firstEntryRow + 3]!
      const firstBulletColumn = firstReference.indexOf("•")
      const secondBulletColumn = secondReference.indexOf("•")

      expect(firstEntryRow).toBeGreaterThanOrEqual(0)
      expect(firstReference.slice(firstBulletColumn)).toStartWith("•  owner/repository#42")
      expect(firstTitle.indexOf("Track pull requests")).toBe(firstBulletColumn + 3)
      expect(secondReference.slice(secondBulletColumn)).toStartWith("•  another/project#7")
      expect(secondTitle.indexOf("Track pull requests")).toBe(secondBulletColumn + 3)
    } finally {
      await sidebar.cleanup()
    }
  })

  test("renders compact pull request entries on consecutive rows without titles", async () => {
    const sidebar = await renderSidebar([attachment, secondAttachment], { layout: "compact" })
    try {
      const frame = await sidebar.view.waitForFrame(
        (value) => value.includes("owner/repository#42") && value.includes("another/project#7"),
      )
      const rows = frame.split("\n")
      const firstEntryRow = rows.findIndex((row) => row.includes("owner/repository#42"))
      const secondEntryRow = rows.findIndex((row) => row.includes("another/project#7"))
      const firstEntry = rows[firstEntryRow]!
      const secondEntry = rows[secondEntryRow]!

      expect(frame).not.toContain("Track pull requests")
      expect(firstEntry.trimStart()).toStartWith("•  owner/repository#42 passed")
      expect(secondEntry.trimStart()).toStartWith("•  another/project#7 passed")
      expect(secondEntryRow).toBe(firstEntryRow + 1)
    } finally {
      await sidebar.cleanup()
    }
  })

  test("renders partial Stack markers and an internal gap in the default layout", async () => {
    const parsed = [11, 12, 13, 14, 15, 16].map((number) =>
      parsePullRequestUrl(`https://github.com/owner/repository/pull/${number}`),
    )
    if (parsed.some((result) => !result.ok)) throw new Error("Stack test fixture URL is invalid")
    const members = parsed.map((result) => (result.ok ? result.value : pullRequest))
    const attached = [members[1]!, members[3]!, members[4]!]
    const membership = stackMembership("stack-1", members)
    const memberships = attached.map(() => membership)
    const items = attached.map((value, index) => ({
      pullRequest: value,
      attachedAt: `2026-08-15T12:0${index}:00.000Z`,
    }))
    const statuses = new Map([
      [
        attached[0]!.url,
        available(
          { tag: "Open", ci: "passed", isDraft: false, mergeability: "mergeable", blocker: "none" },
          attached[0],
        ),
      ],
      [
        attached[1]!.url,
        available(
          { tag: "Open", ci: "pending", isDraft: false, mergeability: "mergeable", blocker: "none" },
          attached[1],
        ),
      ],
      [
        attached[2]!.url,
        available(
          { tag: "Open", ci: "passed", isDraft: true, mergeability: "mergeable", blocker: "none" },
          attached[2],
        ),
      ],
    ])
    const titles = new Map([
      [attached[0]!.url, "Base migration"],
      [attached[1]!.url, "API update"],
      [attached[2]!.url, "Client wiring"],
    ])
    const sidebar = await renderSidebar(items, {
      memberships,
      github: githubStatuses((value) => ({ ...statuses.get(value.url)!, title: titles.get(value.url)! })),
    })
    try {
      const frame = await sidebar.view.waitForFrame((value) => value.includes("Client wiring"))
      const rows = frame.split("\n")
      const firstRow = rows.findIndex((row) => row.includes("owner/repository#12"))
      const gapRow = rows.findIndex((row) => row.includes("PR not attached"))
      const secondRow = rows.findIndex((row) => row.includes("owner/repository#14"))
      const thirdRow = rows.findIndex((row) => row.includes("owner/repository#15"))
      const markerColumn = rows[firstRow]!.indexOf("├")

      expect(rows[firstRow]!.slice(markerColumn)).toStartWith("├─ owner/repository#12 passed")
      expect(rows[firstRow + 1]!.slice(markerColumn)).toStartWith("│  Base migration")
      expect(rows[gapRow]!.slice(markerColumn)).toStartWith("├┄ 1 PR not attached")
      expect(rows[secondRow]!.slice(markerColumn)).toStartWith("├─ owner/repository#14 pending")
      expect(rows[secondRow + 1]!.slice(markerColumn)).toStartWith("│  API update")
      expect(rows[thirdRow]!.slice(markerColumn)).toStartWith("├─ owner/repository#15 draft")
      expect(rows[thirdRow + 1]!.slice(markerColumn)).toStartWith("┊  Client wiring")
      expect(rows[firstRow + 1]!.indexOf("Base migration")).toBe(markerColumn + 3)

      const spans = sidebar.view.captureSpans()
      expect(
        spans.lines[firstRow]!.spans.find((span) => span.text.includes("─"))?.fg.equals(sidebar.colors.success),
      ).toBe(true)
      expect(
        spans.lines[secondRow]!.spans.find((span) => span.text.includes("─"))?.fg.equals(sidebar.colors.warning),
      ).toBe(true)
      expect(
        spans.lines[thirdRow]!.spans.find((span) => span.text.includes("─"))?.fg.equals(sidebar.colors.textMuted),
      ).toBe(true)
      expect(spans.lines[gapRow]!.spans.some((span) => span.fg.equals(sidebar.colors.textMuted))).toBe(true)
    } finally {
      await sidebar.cleanup()
    }
  })

  test("renders Stack markers and gaps without titles in the compact layout", async () => {
    const parsed = [11, 12, 13, 14, 15, 16].map((number) =>
      parsePullRequestUrl(`https://github.com/owner/repository/pull/${number}`),
    )
    if (parsed.some((result) => !result.ok)) throw new Error("Stack test fixture URL is invalid")
    const members = parsed.map((result) => (result.ok ? result.value : pullRequest))
    const attached = [members[1]!, members[3]!, members[4]!]
    const membership = stackMembership("stack-1", members)
    const sidebar = await renderSidebar(
      attached.map((value, index) => ({ pullRequest: value, attachedAt: `2026-08-15T12:0${index}:00.000Z` })),
      { layout: "compact", memberships: attached.map(() => membership) },
    )
    try {
      const frame = await sidebar.view.waitForFrame((value) => value.includes("owner/repository#15"))
      const rows = frame.split("\n")
      const firstRow = rows.findIndex((row) => row.includes("owner/repository#12"))
      const gapRow = rows.findIndex((row) => row.includes("PR not attached"))
      const secondRow = rows.findIndex((row) => row.includes("owner/repository#14"))
      const thirdRow = rows.findIndex((row) => row.includes("owner/repository#15"))

      expect(rows[firstRow]!.trimStart()).toStartWith("├─ owner/repository#12")
      expect(rows[gapRow]!.trimStart()).toStartWith("├┄ 1 PR not attached")
      expect(rows[secondRow]!.trimStart()).toStartWith("├─ owner/repository#14")
      expect(rows[thirdRow]!.trimStart()).toStartWith("├─ owner/repository#15")
      expect(gapRow).toBe(firstRow + 1)
      expect(secondRow).toBe(gapRow + 1)
      expect(thirdRow).toBe(secondRow + 1)
      expect(frame).not.toContain("Track pull requests")
    } finally {
      await sidebar.cleanup()
    }
  })

  test("renders complete boundaries, plural gaps, invalid bullets, and merged strikethrough", async () => {
    const urls = [20, 21, 22, 23, 24, 30, 31, 40, 41].map((number) =>
      parsePullRequestUrl(`https://github.com/owner/repository/pull/${number}`),
    )
    if (urls.some((result) => !result.ok)) throw new Error("Stack test fixture URL is invalid")
    const values = urls.map((result) => (result.ok ? result.value : pullRequest))
    const partialMembers = values.slice(0, 5)
    const completeMembers = values.slice(5, 7)
    const invalidMembers = values.slice(7)
    const partialMembership = stackMembership("stack-partial", partialMembers)
    const completeMembership = stackMembership("stack-complete", completeMembers)
    const invalidMembership = stackMembership("stack-invalid", invalidMembers)
    const items = [values[0]!, values[3]!, values[5]!, values[6]!, values[7]!, values[8]!].map((value, index) => ({
      pullRequest: value,
      attachedAt: `2026-08-15T12:0${index}:00.000Z`,
    }))
    const sidebar = await renderSidebar(items, {
      memberships: [
        partialMembership,
        partialMembership,
        completeMembership,
        completeMembership,
        invalidMembership,
        stackMembership("stack-invalid", [invalidMembers[1]!, invalidMembers[0]!]),
      ],
      github: githubStatuses((value) => available(value.url === values[6]!.url ? { tag: "Merged" } : undefined, value)),
    })
    try {
      const frame = await sidebar.view.waitForFrame((value) => value.includes("owner/repository#41"))
      expect(frame).toContain("┌─ owner/repository#20")
      expect(frame).toContain("├┄ 2 PRs not attached")
      expect(frame).toContain("┌─ owner/repository#30")
      expect(frame).toContain("└─ owner/repository#31 merged")
      expect(frame).toContain("•  owner/repository#40")
      expect(frame).toContain("•  owner/repository#41")

      const mergedRow = frame.split("\n").findIndex((row) => row.includes("owner/repository#31"))
      const mergedSpans = sidebar.view.captureSpans().lines[mergedRow]!.spans
      expect(
        mergedSpans.some(
          (span) =>
            span.text.includes("owner/repository#31") &&
            (span.attributes & TextAttributes.STRIKETHROUGH) === TextAttributes.STRIKETHROUGH,
        ),
      ).toBe(true)
    } finally {
      await sidebar.cleanup()
    }
  })

  test("keeps Stack gaps non-interactive while preserving collapse and pull request clicks", async () => {
    const urls = [40, 41, 42, 43, 44].map((number) =>
      parsePullRequestUrl(`https://github.com/owner/repository/pull/${number}`),
    )
    if (urls.some((result) => !result.ok)) throw new Error("Stack test fixture URL is invalid")
    const members = urls.map((result) => (result.ok ? result.value : pullRequest))
    const attached = [members[0]!, members[2]!, members[4]!]
    const membership = stackMembership("stack-1", members)
    const processCalls: string[] = []
    const runner: ProcessRunner = async (_file, args) => {
      processCalls.push(args[0]!)
      return { stdout: "" }
    }
    const sidebar = await renderSidebar(
      attached.map((value, index) => ({ pullRequest: value, attachedAt: `2026-08-15T12:0${index}:00.000Z` })),
      { memberships: attached.map(() => membership), runner },
    )
    try {
      const frame = await sidebar.view.waitForFrame((value) => value.includes("owner/repository#44"))
      const rows = frame.split("\n")
      const gapRow = rows.findIndex((row) => row.includes("PR not attached"))
      const pullRequestRow = rows.findIndex((row) => row.includes("owner/repository#42"))

      await sidebar.view.mockMouse.click(1, gapRow)
      await sidebar.view.flush()
      expect(processCalls).toEqual([])

      await sidebar.view.mockMouse.click(1, pullRequestRow)
      await sidebar.view.waitFor(() => processCalls.length === 1)
      expect(processCalls).toEqual([attached[1]!.url])

      await sidebar.view.mockMouse.pressDown(1, 0)
      await sidebar.view.flush()
      const collapsed = sidebar.view.captureCharFrame()
      expect(collapsed).toContain("▶ Pull requests")
      expect(collapsed).not.toContain("PR not attached")
      expect(collapsed).not.toContain("owner/repository#42")
    } finally {
      await sidebar.cleanup()
    }
  })

  test("renders the Stack connector beside every wrapped header continuation", async () => {
    const base = parsePullRequestUrl("https://github.com/sample/stacked-service/pull/501")
    const top = parsePullRequestUrl("https://github.com/sample/stacked-service/pull/502")
    if (!base.ok || !top.ok) throw new Error("wrapped Stack test fixture URL is invalid")
    const membership = stackMembership("stack-1", [base.value, top.value])
    const sidebar = await renderSidebar(
      [
        { pullRequest: base.value, attachedAt: "2026-08-15T12:00:00.000Z" },
        { pullRequest: top.value, attachedAt: "2026-08-15T12:01:00.000Z" },
      ],
      {
        width: 36,
        memberships: [membership, membership],
        github: githubStatuses((value) =>
          value.url === base.value.url
            ? {
                ...available({ tag: "Merged" }, value),
                stale: true as const,
                diagnostic: "GitHubUnavailable" as const,
              }
            : available(undefined, value),
        ),
      },
    )
    try {
      const frame = await sidebar.view.waitForFrame((value) => value.includes("merged"))
      const rows = frame.split("\n")
      const referenceRow = rows.findIndex((row) => row.includes("sample/stacked-service#501"))
      const statusRow = rows.findIndex((row) => row.includes("merged"))
      const titleRow = rows.findIndex((row) => row.includes("Track pull requests"))
      const markerColumn = rows[referenceRow]!.indexOf("┌")
      const spans = sidebar.view.captureSpans().lines
      const attributesFor = (row: number, text: string) =>
        spans[row]!.spans.find((span) => span.text.includes(text))!.attributes

      expect(statusRow).toBe(referenceRow + 1)
      expect(rows[statusRow]!.slice(markerColumn)).toStartWith("│  merged")
      expect({
        marker: isStruck(attributesFor(referenceRow, "┌")),
        reference: isStruck(attributesFor(referenceRow, "sample/stacked-service#501")),
        continuation: isStruck(attributesFor(statusRow, "│")),
        status: isStruck(attributesFor(statusRow, "merged")),
        stale: isStruck(attributesFor(statusRow, "stale")),
        staleItalic: (attributesFor(statusRow, "stale") & TextAttributes.ITALIC) === TextAttributes.ITALIC,
        titleMarker: isStruck(attributesFor(titleRow, "│")),
        title: isStruck(attributesFor(titleRow, "Track pull requests")),
      }).toEqual({
        marker: false,
        reference: true,
        continuation: false,
        status: false,
        stale: false,
        staleItalic: true,
        titleMarker: false,
        title: true,
      })
    } finally {
      await sidebar.cleanup()
    }
  })

  test("repeats Stack title connectors across every wrapped title line", async () => {
    const parsed = [601, 602, 603, 604].map((number) =>
      parsePullRequestUrl(`https://github.com/sample/stacked-service/pull/${number}`),
    )
    if (parsed.some((result) => !result.ok)) throw new Error("wrapped title fixture URL is invalid")
    const members = parsed.map((result) => (result.ok ? result.value : pullRequest))
    const attached = [members[1]!, members[2]!]
    const membership = stackMembership("synthetic-stack", members)
    const titles = new Map([
      [attached[0]!.url, "Synthetic migration policy validates staged resource ownership"],
      [attached[1]!.url, "Synthetic rollout metadata preserves deterministic handoff ordering"],
    ])
    const sidebar = await renderSidebar(
      attached.map((value, index) => ({
        pullRequest: value,
        attachedAt: `2026-08-15T12:0${index}:00.000Z`,
      })),
      {
        width: 38,
        memberships: [membership, membership],
        github: githubStatuses((value) => ({
          ...available(value.url === attached[0]!.url ? { tag: "Merged" } : undefined, value),
          title: titles.get(value.url)!,
        })),
      },
    )
    try {
      const frame = await sidebar.view.waitForFrame((value) => value.includes("ordering"))
      const rows = frame.split("\n")
      const markerColumn = rows.find((row) => row.includes("sample/stacked-service#602"))!.indexOf("├")
      const secondReferenceRow = rows.findIndex((row) => row.includes("sample/stacked-service#603"))
      const continuingTitleStart = rows.findIndex((row) => row.includes("Synthetic migration"))
      const incompleteUpperTitleStart = rows.findIndex((row) => row.includes("Synthetic rollout"))
      const continuingTitleRows = rows
        .slice(continuingTitleStart, secondReferenceRow)
        .filter((row) => row.trim().length > 0)
      const incompleteUpperTitleRows = rows.slice(incompleteUpperTitleStart).filter((row) => row.trim().length > 0)

      expect(continuingTitleRows.length).toBeGreaterThan(1)
      expect(incompleteUpperTitleRows.length).toBeGreaterThan(1)
      expect({
        continuingMarkers: continuingTitleRows.map((row) => row.slice(markerColumn, markerColumn + 3)),
        continuingContentColumns: continuingTitleRows.map((row) => row.slice(markerColumn + 3).search(/\S/)),
        incompleteUpperMarkers: incompleteUpperTitleRows.map((row) => row.slice(markerColumn, markerColumn + 3)),
        incompleteUpperContentColumns: incompleteUpperTitleRows.map((row) => row.slice(markerColumn + 3).search(/\S/)),
      }).toEqual({
        continuingMarkers: continuingTitleRows.map(() => "│  "),
        continuingContentColumns: continuingTitleRows.map(() => 0),
        incompleteUpperMarkers: incompleteUpperTitleRows.map(() => "┊  "),
        incompleteUpperContentColumns: incompleteUpperTitleRows.map(() => 0),
      })

      const spans = sidebar.view.captureSpans().lines
      for (const row of [...continuingTitleRows, ...incompleteUpperTitleRows]) {
        const rowIndex = rows.indexOf(row)
        const titleSpans = spans[rowIndex]!.spans
        const marker = titleSpans[0]!
        const title = titleSpans.reduce((last, span) => (span.text.trim().length > 0 ? span : last), marker)
        expect(isStruck(marker.attributes)).toBe(false)
        expect(isStruck(title.attributes)).toBe(rowIndex < secondReferenceRow)
      }
    } finally {
      await sidebar.cleanup()
    }
  })

  test("colors Stack marker glyphs independently from status and default gutters", async () => {
    const standalone = parsePullRequestUrl("https://github.com/sample/color-fixture/pull/700")
    const parsed = [701, 702, 703, 704].map((number) =>
      parsePullRequestUrl(`https://github.com/sample/color-fixture/pull/${number}`),
    )
    if (!standalone.ok || parsed.some((result) => !result.ok)) throw new Error("color fixture URL is invalid")
    const members = parsed.map((result) => (result.ok ? result.value : pullRequest))
    const attached = [members[0]!, members[2]!, members[3]!]
    const membership = stackMembership("synthetic-color-stack", members)
    const titles = new Map([
      [standalone.value.url, "Synthetic standalone title"],
      [attached[0]!.url, "Synthetic color verification keeps connector shades stable"],
      [attached[1]!.url, "Synthetic middle title"],
      [attached[2]!.url, "Synthetic final title"],
    ])
    const sidebar = await renderSidebar(
      [
        { pullRequest: standalone.value, attachedAt: "2026-08-15T12:00:00.000Z" },
        ...attached.map((value, index) => ({
          pullRequest: value,
          attachedAt: `2026-08-15T12:0${index + 1}:00.000Z`,
        })),
      ],
      {
        width: 30,
        memberships: [{ tag: "Standalone", pullRequest: standalone.value }, membership, membership, membership],
        github: githubStatuses((value) => {
          const state: PullRequestState | undefined =
            value.url === standalone.value.url
              ? { tag: "Open", ci: "failed", isDraft: false, mergeability: "mergeable", blocker: "none" }
              : value.url === attached[1]!.url
                ? { tag: "Open", ci: "pending", isDraft: false, mergeability: "mergeable", blocker: "none" }
                : value.url === attached[2]!.url
                  ? { tag: "Merged" }
                  : undefined
          return { ...available(state, value), title: titles.get(value.url)! }
        }),
      },
    )
    try {
      const frame = await sidebar.view.waitForFrame((value) => value.includes("Synthetic final title"))
      const rows = frame.split("\n")
      const spans = sidebar.view.captureSpans().lines
      const rowFor = (text: string) => rows.findIndex((row) => row.includes(text))
      const spanFor = (row: number, glyph: string) => spans[row]!.spans.find((span) => span.text.includes(glyph))
      const colorName = (span: (typeof spans)[number]["spans"][number] | undefined) => {
        if (span?.fg.equals(sidebar.colors.textMuted)) return "gray"
        if (span?.fg.equals(sidebar.colors.error)) return "red"
        if (span?.fg.equals(sidebar.colors.success)) return "green"
        if (span?.fg.equals(sidebar.colors.warning)) return "yellow"
        if (span?.fg.equals(sidebar.colors.secondary)) return "purple"
        return "missing"
      }
      const standaloneRow = rowFor("sample/color-fixture#700")
      const firstRow = rowFor("sample/color-fixture#701")
      const middleRow = rowFor("sample/color-fixture#703")
      const finalRow = rowFor("sample/color-fixture#704")
      const gapRow = rowFor("PR not attached")
      const wrappedHeaderRow = rowFor("passed")
      const titleStart = rowFor("Synthetic color")
      const titleRows = rows.slice(titleStart, gapRow).filter((row) => row.trim().length > 0)

      expect(titleRows.length).toBeGreaterThan(1)
      expect({
        bullet: colorName(spanFor(standaloneRow, "•")),
        firstJunction: colorName(spanFor(firstRow, "┌")),
        firstHorizontal: colorName(spanFor(firstRow, "─")),
        middleJunction: colorName(spanFor(middleRow, "├")),
        middleHorizontal: colorName(spanFor(middleRow, "─")),
        finalJunction: colorName(spanFor(finalRow, "└")),
        finalHorizontal: colorName(spanFor(finalRow, "─")),
        wrappedHeaderConnector: colorName(spanFor(wrappedHeaderRow, "│")),
        wrappedTitleConnectors: titleRows.map((row) => colorName(spanFor(rows.indexOf(row), "│"))),
        gap: colorName(spanFor(gapRow, "PR not attached")),
      }).toEqual({
        bullet: "red",
        firstJunction: "gray",
        firstHorizontal: "green",
        middleJunction: "gray",
        middleHorizontal: "yellow",
        finalJunction: "gray",
        finalHorizontal: "purple",
        wrappedHeaderConnector: "gray",
        wrappedTitleConnectors: titleRows.map(() => "gray"),
        gap: "gray",
      })
    } finally {
      await sidebar.cleanup()
    }
  })

  test("aligns standalone and Stack pull request references to one marker gutter", async () => {
    const standalone = parsePullRequestUrl("https://github.com/sample/stacked-service/pull/503")
    const base = parsePullRequestUrl("https://github.com/sample/stacked-service/pull/504")
    const top = parsePullRequestUrl("https://github.com/sample/stacked-service/pull/505")
    if (!standalone.ok || !base.ok || !top.ok) throw new Error("mixed Stack test fixture URL is invalid")
    const membership = stackMembership("stack-1", [base.value, top.value])
    const sidebar = await renderSidebar(
      [
        { pullRequest: standalone.value, attachedAt: "2026-08-15T12:00:00.000Z" },
        { pullRequest: base.value, attachedAt: "2026-08-15T12:01:00.000Z" },
        { pullRequest: top.value, attachedAt: "2026-08-15T12:02:00.000Z" },
      ],
      {
        memberships: [{ tag: "Standalone", pullRequest: standalone.value }, membership, membership],
      },
    )
    try {
      const frame = await sidebar.view.waitForFrame((value) => value.includes("sample/stacked-service#505"))
      const rows = frame.split("\n")
      const referenceColumns = [503, 504, 505].map((number) =>
        rows.find((row) => row.includes(`sample/stacked-service#${number}`))!.indexOf("sample/stacked-service"),
      )

      expect(referenceColumns).toEqual([3, 3, 3])
    } finally {
      await sidebar.cleanup()
    }
  })

  test("preserves pull request titles for unexpected runtime layout values", async () => {
    const sidebar = await renderSidebar([attachment], {
      layout: "unexpected" as PullRequestSidebarLayout,
    })
    try {
      const frame = await sidebar.view.waitForFrame((value) => value.includes("owner/repository#42"))

      expect(frame).toContain("Track pull requests")
    } finally {
      await sidebar.cleanup()
    }
  })

  test("aligns wrapped status text and the title after the list bullet", async () => {
    const sidebar = await renderSidebar([attachment], { width: 24 })
    try {
      const frame = await sidebar.view.waitForFrame(
        (value) => value.includes("owner/repository#42") && value.includes("Track pull requests"),
      )
      const rows = frame.split("\n")
      const referenceRow = rows.findIndex((row) => row.includes("owner/repository#42"))
      const titleRow = rows.findIndex((row) => row.includes("Track pull requests"))
      const bulletColumn = rows[referenceRow]!.indexOf("•")
      const continuationRows = rows.slice(referenceRow + 1, titleRow + 1)

      expect(continuationRows.length).toBeGreaterThan(1)
      for (const row of continuationRows) {
        expect(row.search(/\S/)).toBe(bulletColumn + 3)
      }
    } finally {
      await sidebar.cleanup()
    }
  })

  test("does not add space after an empty pull request list", async () => {
    const sidebar = await renderSidebar([], { followingText: "Following content" })
    try {
      const frame = await sidebar.view.waitForFrame(
        (value) => value.includes("No pull requests attached") && value.includes("Following content"),
      )
      const rows = frame.split("\n")
      const emptyStateRow = rows.findIndex((row) => row.includes("No pull requests attached"))
      const followingContentRow = rows.findIndex((row) => row.includes("Following content"))

      expect(followingContentRow).toBe(emptyStateRow + 1)
    } finally {
      await sidebar.cleanup()
    }
  })

  test("renders stale status as a separate soft-failure marker", async () => {
    let availableResponse = true
    const github: GitHubClient = {
      async getStack(requested) {
        return { ok: true, value: [requested] }
      },
      async getStacks(requested) {
        return {
          ok: true,
          value: requested.map((value) => ({
            ok: true,
            value: { tag: "Standalone", pullRequest: value },
          })),
        }
      },
      async get(pullRequests) {
        return availableResponse
          ? {
              ok: true,
              value: pullRequests.map((value) => ({ ok: true, value: available(undefined, value) })),
            }
          : {
              ok: false,
              error: {
                tag: "GitHubUnavailable",
                message: "GitHub status unavailable",
                cause: new Error("offline"),
              },
            }
      },
    }
    const sidebar = await renderSidebar([attachment], { github })
    try {
      availableResponse = false
      sidebar.emitSessionUpdated()
      await sidebar.view.waitFor(() => sidebar.githubCalls() === 2)
      const frame = await sidebar.view.waitForFrame((value) => value.includes("passed · stale"))

      expect(frame).toContain("owner/repository#42 passed · stale")
      expect(frame).not.toContain("GitHub unavailable")
    } finally {
      await sidebar.cleanup()
    }
  })

  test("preserves the attach helper while rejecting an unresolved pull request without mutation", async () => {
    const store = stateStore([])
    let requestSignal: AbortSignal | undefined
    const github: GitHubClient = {
      async getStack(_requested, options) {
        requestSignal = options?.signal
        return {
          ok: false,
          error: {
            tag: "PullRequestNotFound",
            message: "Pull request does not exist or is not accessible",
          },
        }
      },
      async getStacks(requested) {
        return {
          ok: true,
          value: requested.map((value) => ({
            ok: true,
            value: { tag: "Standalone", pullRequest: value },
          })),
        }
      },
      async get() {
        throw new Error("status lookup is not expected")
      },
    }
    const signal = new AbortController().signal

    expect(await attachPullRequest(store, "session", "https://example.com/pull/1")).toMatchObject({
      ok: false,
      error: { tag: "InvalidPullRequestUrl" },
    })
    expect(
      await attachPullRequest(store, "session", pullRequest.url, {
        github,
        signal,
      }),
    ).toEqual({
      ok: false,
      error: {
        tag: "PullRequestNotFound",
        message: "Pull request does not exist or is not accessible",
      },
    })
    expect(requestSignal).toBe(signal)
    expect(await store.list("session")).toEqual({ ok: true, value: [] })
  })

  test("resolves numeric attach input against the current session directory", async () => {
    type Command = Readonly<{ name: string; run(): Promise<void> }>
    const commands = new Map<string, Command>()
    const attached: string[] = []
    const processCalls: Array<{
      file: string
      args: readonly string[]
      options: Readonly<{ signal?: AbortSignal; cwd?: string }>
    }> = []
    const store: StateStore = {
      ...stateStore([]),
      async attach(sessionID, value, options) {
        const validation = await options?.validate?.()
        if (validation !== undefined && !validation.ok) return validation
        attached.push(`${sessionID}:${value.url}`)
        return { ok: true, value: "added" }
      },
    }
    const runner: ProcessRunner = async (file, args, options) => {
      processCalls.push({ file, args, options })
      return { stdout: '{"url":"https://github.com/owner/repository"}' }
    }
    const controller = new AbortController()
    const api = {
      state: { path: { directory: "/project" } },
      route: { current: { name: "session", params: { sessionID: "session" } } },
      keymap: {
        registerLayer(layer: { commands: Command[] }) {
          for (const command of layer.commands) commands.set(command.name, command)
          return () => undefined
        },
      },
      slots: { register: () => "pr-tracker" },
      lifecycle: {
        signal: controller.signal,
        onDispose: () => () => undefined,
      },
      event: { on: () => () => undefined },
      ui: {
        DialogPrompt(props: { onConfirm(value: string): void; onCancel?(): void }) {
          props.onConfirm("42")
          setTimeout(() => props.onCancel?.(), 10)
          return null
        },
        dialog: {
          clear() {},
          setSize() {},
          replace(render: () => unknown) {
            render()
          },
        },
        toast() {},
      },
    } as unknown as TuiPluginApi

    registerPullRequestCommands(api, { store, github: githubStatuses(), runner })

    await commands.get("pr.attach")!.run()

    expect(processCalls).toHaveLength(1)
    expect(processCalls[0]).toMatchObject({
      file: "gh",
      args: ["repo", "view", "--json", "url"],
      options: { cwd: "/project" },
    })
    expect(processCalls[0]?.options.signal).toBeInstanceOf(AbortSignal)
    expect(attached).toEqual(["session:https://github.com/owner/repository/pull/42"])
  })

  test("surfaces a missing pull request without mutating session state", async () => {
    type Command = Readonly<{ name: string; run(): Promise<void> }>
    const commands = new Map<string, Command>()
    const toasts: string[] = []
    const store = stateStore([])
    let requestSignal: AbortSignal | undefined
    const github: GitHubClient = {
      async getStack(_requested, options) {
        requestSignal = options?.signal
        return {
          ok: false,
          error: {
            tag: "PullRequestNotFound",
            message: "Pull request does not exist or is not accessible",
          },
        }
      },
      async getStacks(requested) {
        return {
          ok: true,
          value: requested.map((value) => ({
            ok: true,
            value: { tag: "Standalone", pullRequest: value },
          })),
        }
      },
      async get() {
        throw new Error("status lookup is not expected")
      },
    }
    const controller = new AbortController()
    const api = {
      state: { path: { directory: "/project" } },
      route: { current: { name: "session", params: { sessionID: "session" } } },
      keymap: {
        registerLayer(layer: { commands: Command[] }) {
          for (const command of layer.commands) commands.set(command.name, command)
          return () => undefined
        },
      },
      slots: { register: () => "pr-tracker" },
      lifecycle: {
        signal: controller.signal,
        onDispose: () => () => undefined,
      },
      event: { on: () => () => undefined },
      ui: {
        DialogPrompt(props: { onConfirm(value: string): void }) {
          props.onConfirm(pullRequest.url)
          return null
        },
        dialog: {
          clear() {},
          setSize() {},
          replace(render: () => unknown) {
            render()
          },
        },
        toast(input: { message: string }) {
          toasts.push(input.message)
        },
      },
    } as unknown as TuiPluginApi

    registerPullRequestCommands(api, { store, github })

    await commands.get("pr.attach")!.run()

    expect(toasts).toEqual(["Pull request does not exist or is not accessible"])
    expect(requestSignal).toBe(controller.signal)
    expect(await store.list("session")).toEqual({ ok: true, value: [] })
  })

  test("does not attach numeric input when repository resolution fails", async () => {
    type Command = Readonly<{ name: string; run(): Promise<void> }>
    const commands = new Map<string, Command>()
    let attachCalls = 0
    const store: StateStore = {
      ...stateStore([]),
      async attach() {
        attachCalls += 1
        return { ok: true, value: "added" }
      },
    }
    const cause = new Error("gh failed")
    const runner: ProcessRunner = async () => {
      throw cause
    }
    const api = {
      state: { path: { directory: "/project" } },
      route: { current: { name: "session", params: { sessionID: "session" } } },
      keymap: {
        registerLayer(layer: { commands: Command[] }) {
          for (const command of layer.commands) commands.set(command.name, command)
          return () => undefined
        },
      },
      slots: { register: () => "pr-tracker" },
      lifecycle: {
        signal: new AbortController().signal,
        onDispose: () => () => undefined,
      },
      event: { on: () => () => undefined },
      ui: {
        DialogPrompt(props: { onConfirm(value: string): void; onCancel?(): void }) {
          props.onConfirm("42")
          setTimeout(() => props.onCancel?.(), 10)
          return null
        },
        dialog: {
          clear() {},
          setSize() {},
          replace(render: () => unknown) {
            render()
          },
        },
        toast() {},
      },
    } as unknown as TuiPluginApi

    registerPullRequestCommands(api, { store, github: githubStatuses(), runner })

    await commands.get("pr.attach")!.run()

    expect(attachCalls).toBe(0)
  })

  test("cancels an open attach dialog when the plugin lifecycle ends", async () => {
    type Command = Readonly<{ name: string; run(): Promise<void> }>
    const commands = new Map<string, Command>()
    const controller = new AbortController()
    let confirm: ((value: string) => void) | undefined
    let dismiss: (() => void) | undefined
    let clearCalls = 0
    let attachCalls = 0
    let runnerCalls = 0
    const store: StateStore = {
      ...stateStore([]),
      async attach() {
        attachCalls += 1
        return { ok: true, value: "added" }
      },
    }
    const api = {
      state: { path: { directory: "/project" } },
      route: { current: { name: "session", params: { sessionID: "session" } } },
      keymap: {
        registerLayer(layer: { commands: Command[] }) {
          for (const command of layer.commands) commands.set(command.name, command)
          return () => undefined
        },
      },
      slots: { register: () => "pr-tracker" },
      lifecycle: {
        signal: controller.signal,
        onDispose: () => () => undefined,
      },
      event: { on: () => () => undefined },
      ui: {
        DialogPrompt(props: { onConfirm(value: string): void }) {
          confirm = (value) => props.onConfirm(value)
          return null
        },
        dialog: {
          clear() {
            clearCalls += 1
          },
          setSize() {},
          replace(render: () => unknown, onDismiss: () => void) {
            dismiss = onDismiss
            render()
          },
        },
        toast() {},
      },
    } as unknown as TuiPluginApi

    const runner: ProcessRunner = async () => {
      runnerCalls += 1
      return { stdout: '{"url":"https://github.com/owner/repository"}' }
    }

    registerPullRequestCommands(api, { store, github: githubStatuses(), runner })

    const run = commands.get("pr.attach")!.run()
    controller.abort()
    const outcome = await Promise.race([
      run.then(() => "resolved" as const),
      Bun.sleep(10).then(() => "pending" as const),
    ])
    if (outcome === "pending") {
      dismiss?.()
      await run
    }
    confirm?.("42")
    await Bun.sleep(0)

    expect(outcome).toBe("resolved")
    expect(clearCalls).toBe(1)
    expect(runnerCalls).toBe(0)
    expect(attachCalls).toBe(0)
  })

  test("cancels an open detach dialog when the plugin lifecycle ends", async () => {
    type Command = Readonly<{ name: string; run(): Promise<void> }>
    const commands = new Map<string, Command>()
    const controller = new AbortController()
    let select: ((option: { value: PullRequestUrl }) => void) | undefined
    let markDialogOpened: (() => void) | undefined
    const dialogOpened = new Promise<void>((resolve) => {
      markDialogOpened = resolve
    })
    let clearCalls = 0
    let detachCalls = 0
    const store: StateStore = {
      ...stateStore(),
      async detach() {
        detachCalls += 1
        return { ok: true, value: "removed" }
      },
    }
    const api = {
      route: { current: { name: "session", params: { sessionID: "session" } } },
      keymap: {
        registerLayer(layer: { commands: Command[] }) {
          for (const command of layer.commands) commands.set(command.name, command)
          return () => undefined
        },
      },
      slots: { register: () => "pr-tracker" },
      lifecycle: {
        signal: controller.signal,
        onDispose: () => () => undefined,
      },
      event: { on: () => () => undefined },
      ui: {
        DialogSelect(props: { onSelect(option: { value: PullRequestUrl }): void }) {
          select = (option) => props.onSelect(option)
          markDialogOpened?.()
          return null
        },
        dialog: {
          clear() {
            clearCalls += 1
          },
          setSize() {},
          replace(render: () => unknown) {
            render()
          },
        },
        toast() {},
      },
    } as unknown as TuiPluginApi

    registerPullRequestCommands(api, { store, github: githubStatuses() })

    const run = commands.get("pr.detach")!.run()
    await dialogOpened
    controller.abort()
    const outcome = await Promise.race([
      run.then(() => "resolved" as const),
      Bun.sleep(10).then(() => "pending" as const),
    ])
    select?.({ value: pullRequest })
    await run

    expect(outcome).toBe("resolved")
    expect(clearCalls).toBe(1)
    expect(detachCalls).toBe(0)
  })

  test("runs attach, open, and detach commands through shared seams", async () => {
    type Command = Readonly<{ name: string; run(): Promise<void> }>
    const commands = new Map<string, Command>()
    const toasts: string[] = []
    const dialogTitles: string[] = []
    const dialogOptions = new Map<string, readonly { title: string; value: PullRequestUrl; description?: string }[]>()
    const processCalls: Array<{ file: string; args: readonly string[]; signal: AbortSignal | undefined }> = []
    let attachCalls = 0
    let detachCalls = 0
    const store: StateStore = {
      ...stateStore(),
      async list() {
        return { ok: true, value: [attachment] }
      },
      async attach(_sessionID, _pullRequest, options) {
        const validation = await options?.validate?.()
        if (validation !== undefined && !validation.ok) return validation
        attachCalls += 1
        return { ok: true, value: attachCalls === 1 ? "added" : "already_attached" }
      },
      async detach() {
        detachCalls += 1
        return { ok: true, value: detachCalls === 1 ? "removed" : "absent" }
      },
      async detachByNumber() {
        return { ok: true, value: { tag: "absent" } }
      },
      async removeSession() {
        return { ok: true, value: "absent" }
      },
    }
    const api = {
      state: { path: { directory: "/project" } },
      route: { current: { name: "session", params: { sessionID: "session" } } },
      keymap: {
        registerLayer(layer: { commands: Command[] }) {
          for (const command of layer.commands) commands.set(command.name, command)
          return () => undefined
        },
      },
      slots: { register: () => "pr-tracker" },
      lifecycle: {
        signal: new AbortController().signal,
        onDispose: () => () => undefined,
      },
      event: { on: () => () => undefined },
      ui: {
        DialogPrompt(props: { onConfirm(value: string): void }) {
          props.onConfirm(pullRequest.url)
          return null
        },
        DialogSelect(props: {
          title: string
          options: readonly { title: string; value: PullRequestUrl; description?: string }[]
          onSelect(value: { value: PullRequestUrl }): void
        }) {
          dialogTitles.push(props.title)
          dialogOptions.set(props.title, props.options)
          props.onSelect(props.options[0]!)
          return null
        },
        dialog: {
          clear() {},
          setSize() {},
          replace(render: () => unknown) {
            render()
          },
        },
        toast(input: { message: string }) {
          toasts.push(input.message)
        },
      },
    } as unknown as TuiPluginApi
    const runner: ProcessRunner = async (file, args, options) => {
      processCalls.push({ file, args, signal: options.signal })
      return { stdout: "" }
    }

    registerPullRequestCommands(api, { store, github: githubStatuses(), runner })

    await commands.get("pr.attach")!.run()
    await commands.get("pr.attach")!.run()
    await commands.get("pr.open")!.run()
    await commands.get("pr.detach")!.run()
    await commands.get("pr.detach")!.run()

    expect(dialogTitles).toEqual(["Open pull request", "Detach pull request", "Detach pull request"])
    expect(dialogOptions.get("Open pull request")).toEqual([
      { title: "owner/repository#42", value: pullRequest, description: pullRequest.url },
    ])
    expect(dialogOptions.get("Detach pull request")).toEqual([{ title: "owner/repository#42", value: pullRequest }])
    expect(processCalls).toEqual([
      {
        file: process.platform === "darwin" ? "open" : "xdg-open",
        args: [pullRequest.url],
        signal: api.lifecycle.signal,
      },
    ])
    expect(toasts).toEqual([
      "Attached owner/repository#42",
      "owner/repository#42 is already attached",
      "Detached owner/repository#42",
      "owner/repository#42 was not attached",
    ])
  })

  test("warns when the open command has no session or attachments", async () => {
    type Command = Readonly<{ name: string; run(): Promise<void> }>
    const commands = new Map<string, Command>()
    const toasts: string[] = []
    let currentRoute: unknown = { name: "home" }
    const api = {
      route: {
        get current() {
          return currentRoute
        },
      },
      keymap: {
        registerLayer(layer: { commands: Command[] }) {
          for (const command of layer.commands) commands.set(command.name, command)
          return () => undefined
        },
      },
      slots: { register: () => "pr-tracker" },
      lifecycle: {
        signal: new AbortController().signal,
        onDispose: () => () => undefined,
      },
      event: { on: () => () => undefined },
      ui: {
        toast(input: { message: string }) {
          toasts.push(input.message)
        },
      },
    } as unknown as TuiPluginApi

    registerPullRequestCommands(api, { store: stateStore([]), github: githubStatuses() })

    await commands.get("pr.open")!.run()
    currentRoute = { name: "session", params: { sessionID: "session" } }
    await commands.get("pr.open")!.run()

    expect(toasts).toEqual(["Open a session first", "No pull requests are attached"])
  })

  test("reports manual sync outcomes from the refresh bus", async () => {
    type Command = Readonly<{ name: string; run(): Promise<void> }>
    const commands = new Map<string, Command>()
    const toasts: string[] = []
    let currentRoute: unknown = { name: "home" }
    let listCalls = 0
    const store: StateStore = {
      ...stateStore(),
      async list() {
        listCalls += 1
        return { ok: true, value: [attachment] }
      },
    }
    const refreshOutcomes = [
      undefined,
      {
        ok: false,
        error: {
          tag: "InvalidStateFile",
          message: "The session pull request state file is invalid",
        },
      },
      { ok: true, value: "no_attachments" },
      {
        ok: false,
        error: {
          tag: "GitHubUnavailable",
          message: "GitHub status unavailable",
          cause: new Error("offline"),
        },
      },
      { ok: true, value: "stopped" },
      { ok: true, value: "refreshed" },
    ] as const
    let refreshOutcome = 0
    const refreshBus = {
      emit() {},
      async forceRefresh() {
        return refreshOutcomes[refreshOutcome++]
      },
      subscribe() {
        return () => undefined
      },
    }
    const api = {
      route: {
        get current() {
          return currentRoute
        },
      },
      keymap: {
        registerLayer(layer: { commands: Command[] }) {
          for (const command of layer.commands) commands.set(command.name, command)
          return () => undefined
        },
      },
      slots: { register: () => "pr-tracker" },
      lifecycle: {
        signal: new AbortController().signal,
        onDispose: () => () => undefined,
      },
      event: { on: () => () => undefined },
      ui: {
        toast(input: { message: string }) {
          toasts.push(input.message)
        },
      },
    } as unknown as TuiPluginApi

    registerPullRequestCommands(api, { store, github: githubStatuses(), refreshBus })

    await commands.get("pr.sync")!.run()
    currentRoute = { name: "session", params: { sessionID: "session" } }
    await commands.get("pr.sync")!.run()
    await commands.get("pr.sync")!.run()
    await commands.get("pr.sync")!.run()
    await commands.get("pr.sync")!.run()
    await commands.get("pr.sync")!.run()
    await commands.get("pr.sync")!.run()

    expect(listCalls).toBe(0)
    expect(toasts).toEqual([
      "Open a session first",
      "Pull request sidebar is not available",
      "The session pull request state file is invalid",
      "No pull requests are attached",
      "GitHub status unavailable",
      "Unable to refresh pull request status",
      "Pull request status synced",
    ])
  })

  test("awaits manual sync through the refresh bus", async () => {
    type Command = Readonly<{ name: string; run(): Promise<void> }>
    const commands = new Map<string, Command>()
    const toasts: string[] = []
    const requestedSessions: string[] = []
    let finishRefresh: (() => void) | undefined
    let markRefreshStarted: (() => void) | undefined
    const refresh = new Promise<void>((resolve) => {
      finishRefresh = resolve
    })
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve
    })
    const api = {
      route: { current: { name: "session", params: { sessionID: "session" } } },
      keymap: {
        registerLayer(layer: { commands: Command[] }) {
          for (const command of layer.commands) commands.set(command.name, command)
          return () => undefined
        },
      },
      slots: { register: () => "pr-tracker" },
      lifecycle: {
        signal: new AbortController().signal,
        onDispose: () => () => undefined,
      },
      event: { on: () => () => undefined },
      ui: {
        toast(input: { message: string }) {
          toasts.push(input.message)
        },
      },
    } as unknown as TuiPluginApi
    const refreshBus = {
      emit() {},
      async forceRefresh(sessionID: string) {
        requestedSessions.push(sessionID)
        markRefreshStarted?.()
        await refresh
        return { ok: true, value: "refreshed" } as const
      },
      subscribe() {
        return () => undefined
      },
    }

    registerPullRequestCommands(api, { store: stateStore(), github: githubStatuses(), refreshBus })

    const sync = commands.get("pr.sync")!.run()
    await refreshStarted
    expect(toasts).toEqual([])
    finishRefresh?.()
    await sync

    expect(requestedSessions).toEqual(["session"])
    expect(toasts).toEqual(["Pull request status synced"])
  })

  test("reports state and browser failures from the open command", async () => {
    type Command = Readonly<{ name: string; run(): Promise<void> }>
    const commands = new Map<string, Command>()
    const toasts: string[] = []
    let readable = false
    const store: StateStore = {
      ...stateStore(),
      async list() {
        return readable
          ? { ok: true, value: [attachment] }
          : {
              ok: false,
              error: {
                tag: "InvalidStateFile",
                message: "The session pull request state file is invalid",
              },
            }
      },
    }
    const api = {
      route: { current: { name: "session", params: { sessionID: "session" } } },
      keymap: {
        registerLayer(layer: { commands: Command[] }) {
          for (const command of layer.commands) commands.set(command.name, command)
          return () => undefined
        },
      },
      slots: { register: () => "pr-tracker" },
      lifecycle: {
        signal: new AbortController().signal,
        onDispose: () => () => undefined,
      },
      event: { on: () => () => undefined },
      ui: {
        DialogSelect(props: {
          options: readonly { value: PullRequestUrl }[]
          onSelect(value: { value: PullRequestUrl }): void
        }) {
          props.onSelect(props.options[0]!)
          return null
        },
        dialog: {
          clear() {},
          setSize() {},
          replace(render: () => unknown) {
            render()
          },
        },
        toast(input: { message: string }) {
          toasts.push(input.message)
        },
      },
    } as unknown as TuiPluginApi
    const cause = new Error("process failed")
    const runner: ProcessRunner = async () => {
      throw cause
    }

    registerPullRequestCommands(api, { store, github: githubStatuses(), runner })

    await commands.get("pr.open")!.run()
    readable = true
    await commands.get("pr.open")!.run()

    expect(toasts).toEqual(["The session pull request state file is invalid", "Unable to open the pull request"])
  })
})
