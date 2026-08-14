import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { RGBA } from "@opentui/core"
import { testRender, type JSX } from "@opentui/solid"
import type { PluginOptions } from "@opencode-ai/plugin"
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"

import * as tui from "../src/tui.jsx"
import { openPullRequest } from "../src/external-url.js"
import { updateStatusLabel } from "../src/plugin-update-tui.js"
import { startSessionPolling } from "../src/polling.js"
import { attachPullRequest, type PullRequestSidebarLayout } from "../src/pull-request-tui.js"
import { createStateStore } from "../src/state.js"
import { attachment, githubStatuses, stateStore } from "./tui-fixtures.js"

async function renderComposedSidebar(
  register: (api: TuiPluginApi, meta: TuiPluginMeta) => void | Promise<void>,
): Promise<string> {
  const dataHome = await mkdtemp(join(tmpdir(), "opencode-pr-tracker-tui-"))
  const previousDataHome = process.env.XDG_DATA_HOME
  const previousPath = process.env.PATH
  const controller = new AbortController()
  let view: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    process.env.XDG_DATA_HOME = dataHome
    process.env.PATH = dataHome
    const attached = await createStateStore().attach("session", attachment.pullRequest)
    if (!attached.ok) throw new Error(attached.error.message)

    let sidebarContent: ((context: unknown, value: Readonly<{ session_id: string }>) => JSX.Element) | undefined
    const color = RGBA.fromHex("#ffffff")
    const api = {
      keymap: {
        registerLayer() {
          return () => undefined
        },
      },
      slots: {
        register(value: {
          slots: {
            sidebar_content(context: unknown, slot: Readonly<{ session_id: string }>): JSX.Element
          }
        }) {
          sidebarContent = (context, slot) => value.slots.sidebar_content(context, slot)
          return "pr-tracker"
        },
      },
      lifecycle: {
        signal: controller.signal,
        onDispose() {
          return () => undefined
        },
      },
      event: {
        on() {
          return () => undefined
        },
      },
      theme: {
        current: {
          text: color,
          textMuted: color,
          error: color,
          warning: color,
          success: color,
          secondary: color,
        },
      },
      ui: { toast() {} },
      state: { path: { directory: dataHome, worktree: dataHome } },
    } as unknown as TuiPluginApi
    const meta = {
      id: "opencode-pr-tracker",
      source: "file",
      spec: "test",
      target: "test",
      first_time: 0,
      last_time: 0,
      time_changed: 0,
      load_count: 1,
      fingerprint: "test",
      state: "same",
    } satisfies TuiPluginMeta

    await register(api, meta)
    if (sidebarContent === undefined) throw new Error("sidebar slot was not registered")
    view = await testRender(() => sidebarContent!({}, { session_id: "session" }), { width: 80, height: 10 })
    return await view.waitForFrame((frame) => frame.includes("owner/repository#42"))
  } finally {
    controller.abort()
    view?.renderer.destroy()
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousDataHome
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    await rm(dataHome, { recursive: true, force: true })
  }
}

describe("TUI composition root", () => {
  test.each([
    [undefined, "default"],
    [{}, "default"],
    [{ layout: "default" }, "default"],
    [{ layout: "compact" }, "compact"],
    [{ layout: "dense" }, "default"],
    [{ layout: true }, "default"],
  ] satisfies Array<[PluginOptions | undefined, PullRequestSidebarLayout]>)(
    "parses sidebar layout option %#",
    (options, expected) => {
      expect(tui.parseSidebarLayout(options)).toBe(expected)
    },
  )

  test("re-exports the domain compatibility surface", () => {
    expect(tui.attachPullRequest).toBe(attachPullRequest)
    expect(tui.openPullRequest).toBe(openPullRequest)
    expect(tui.startSessionPolling).toBe(startSessionPolling)
    expect(tui.updateStatusLabel).toBe(updateStatusLabel)
  })

  test("composes the default and parsed compact layouts into the sidebar", async () => {
    const defaultFrame = await renderComposedSidebar((api, meta) => tui.default.tui(api, undefined, meta))
    const compactFrame = await renderComposedSidebar((api, meta) => tui.default.tui(api, { layout: "compact" }, meta))

    expect(defaultFrame).toContain("Title unavailable")
    expect(compactFrame).not.toContain("Title unavailable")
  })

  test("renders the default sidebar layout when registerTui omits layout", async () => {
    const frame = await renderComposedSidebar((api) =>
      tui.registerTui(api, { store: stateStore(), github: githubStatuses() }),
    )

    expect(frame).toContain("Track pull requests")
  })

  test("registers model-free slash commands and the sidebar slot", () => {
    let layer: { commands: Array<{ name: string; slashName?: string }> } | undefined
    let slots: Record<string, unknown> | undefined
    const disposers: Array<() => void> = []
    const events: string[] = []
    const eventHandlers = new Map<string, (event: { properties: { sessionID: string } }) => void>()
    const emittedSessionIDs: string[] = []
    const disposedEvents: string[] = []
    let commandsDisposed = false
    const api = {
      keymap: {
        registerLayer(value: typeof layer) {
          layer = value
          return () => {
            commandsDisposed = true
          }
        },
      },
      slots: {
        register(value: { slots: Record<string, unknown> }) {
          slots = value.slots
          return "pr-tracker"
        },
      },
      lifecycle: {
        signal: new AbortController().signal,
        onDispose(disposer: () => void) {
          disposers.push(disposer)
          return () => undefined
        },
      },
      event: {
        on(type: string, handler: (event: { properties: { sessionID: string } }) => void) {
          events.push(type)
          eventHandlers.set(type, handler)
          return () => {
            disposedEvents.push(type)
          }
        },
      },
    } as unknown as TuiPluginApi

    tui.registerTui(api, {
      store: stateStore(),
      github: githubStatuses(),
      refreshBus: {
        emit(sessionID) {
          emittedSessionIDs.push(sessionID)
        },
        async forceRefresh() {
          return undefined
        },
        subscribe() {
          return () => undefined
        },
      },
    })

    expect(layer?.commands.map(({ name, slashName }) => ({ name, slashName }))).toEqual([
      { name: "pr.attach", slashName: "pr-attach" },
      { name: "pr.open", slashName: "pr-open" },
      { name: "pr.detach", slashName: "pr-detach" },
      { name: "pr.sync", slashName: "pr-sync" },
      { name: "pr.tracker.plugin.update", slashName: "pr-tracker-plugin-update" },
    ])
    expect(slots).toHaveProperty("sidebar_content")
    expect(disposers).toHaveLength(1)
    expect(events).toEqual(["session.updated", "message.updated", "message.part.updated"])
    const sessionIDs = ["session-updated", "message-updated", "message-part-updated"]
    for (const [index, event] of events.entries()) {
      expect(() => eventHandlers.get(event)?.({ properties: { sessionID: sessionIDs[index]! } })).not.toThrow()
    }
    expect(emittedSessionIDs).toEqual(sessionIDs)

    disposers[0]?.()

    expect(commandsDisposed).toBe(true)
    expect(disposedEvents).toEqual(["session.updated", "message.updated", "message.part.updated"])
  })
})
