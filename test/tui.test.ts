import { describe, expect, test } from "bun:test"

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

import * as tui from "../src/tui.jsx"
import { openPullRequest } from "../src/external-url.js"
import { updateStatusLabel } from "../src/plugin-update-tui.js"
import { startSessionPolling } from "../src/polling.js"
import { attachPullRequest } from "../src/pull-request-tui.js"
import { githubStatuses, stateStore } from "./tui-fixtures.js"

describe("TUI composition root", () => {
  test("re-exports the domain compatibility surface", () => {
    expect(tui.attachPullRequest).toBe(attachPullRequest)
    expect(tui.openPullRequest).toBe(openPullRequest)
    expect(tui.startSessionPolling).toBe(startSessionPolling)
    expect(tui.updateStatusLabel).toBe(updateStatusLabel)
  })

  test("registers model-free slash commands and the sidebar slot", () => {
    let layer: { commands: Array<{ name: string; slashName?: string }> } | undefined
    let slots: Record<string, unknown> | undefined
    const disposers: Array<() => void> = []
    const events: string[] = []
    const eventHandlers = new Map<string, (event: { properties: { sessionID: string } }) => void>()
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

    tui.registerTui(api, { store: stateStore(), github: githubStatuses() })

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
    for (const event of events) {
      expect(() => eventHandlers.get(event)?.({ properties: { sessionID: "session" } })).not.toThrow()
    }

    disposers[0]?.()

    expect(commandsDisposed).toBe(true)
    expect(disposedEvents).toEqual(["session.updated", "message.updated", "message.part.updated"])
  })
})
