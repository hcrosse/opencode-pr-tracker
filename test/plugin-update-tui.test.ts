import { describe, expect, test } from "bun:test"

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

import { createPluginUpdateController, updateStatusLabel } from "../src/plugin-update-tui.js"

describe("plugin update TUI", () => {
  test("exposes cached plugin update state through the controller boundary", async () => {
    const now = new Date("2026-08-11T12:00:00.000Z").valueOf()
    const observed: Array<string | undefined> = []
    let checks = 0
    const api = {
      app: { version: "1.18.15" },
      kv: {
        ready: true,
        get() {
          return {
            checkedAt: now,
            currentVersion: "0.2.0",
            opencodeVersion: "1.18.15",
            availableVersion: "0.2.1",
          }
        },
      },
      lifecycle: { signal: new AbortController().signal },
    } as unknown as TuiPluginApi

    const updates = createPluginUpdateController(
      api,
      {
        now: () => now,
        async updateChecker() {
          checks += 1
          return { ok: true, value: undefined }
        },
      },
      { source: "npm", version: "0.2.0" },
    )
    const unsubscribe = updates.subscribe((version) => observed.push(version))
    await updates.startup
    unsubscribe()

    expect(updates.command).toMatchObject({
      name: "pr.tracker.plugin.update",
      title: "Update PR tracker plugin",
      category: "Plugin",
      namespace: "palette",
      slashName: "pr-tracker-plugin-update",
    })
    expect(updates.current()).toBe("0.2.1")
    expect(observed).toEqual(["0.2.1"])
    expect(checks).toBe(0)
  })

  test("shows minimal update status and scoped instructions without installing", async () => {
    const toasts: string[] = []
    const dialogs: Array<{ title: string; message: string }> = []
    const cache = new Map<string, unknown>()
    const scopeInputs: Array<{ projectConfigDirectory: string; globalConfigDirectory: string }> = []
    let kvReady = false
    const signals: Array<AbortSignal | undefined> = []
    let checks = 0
    let markFirstCheckStarted: (() => void) | undefined
    const firstCheckStarted = new Promise<void>((resolve) => {
      markFirstCheckStarted = resolve
    })
    let resolveFirstCheck: ((value: { currentVersion: string; version: string }) => void) | undefined
    const firstCheck = new Promise<{ currentVersion: string; version: string }>((resolve) => {
      resolveFirstCheck = resolve
    })
    const controller = new AbortController()
    const api = {
      app: { version: "1.18.15" },
      state: { path: { config: "/global", worktree: "/", directory: "/project" } },
      route: { current: { name: "home" } },
      kv: {
        get ready() {
          return kvReady
        },
        get(key: string) {
          return cache.get(key)
        },
        set(key: string, value: unknown) {
          cache.set(key, value)
        },
      },
      lifecycle: {
        signal: controller.signal,
        onDispose: () => () => undefined,
      },
      ui: {
        DialogAlert(props: { title: string; message: string }) {
          dialogs.push(props)
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

    const updates = createPluginUpdateController(
      api,
      {
        now: () => new Date("2026-08-11T12:00:00.000Z").valueOf(),
        async updateChecker(_versions, options) {
          checks += 1
          signals.push(options?.signal)
          if (checks === 1) {
            markFirstCheckStarted?.()
            return { ok: true, value: await firstCheck }
          }
          return { ok: true, value: { currentVersion: "0.2.0", version: "0.2.2" } }
        },
        async installationScopes(input) {
          scopeInputs.push(input)
          return ["project"]
        },
      },
      { source: "npm", version: "0.2.0" },
    )

    let commandFinished = false
    const commandRun = updates.command.run().then(() => {
      commandFinished = true
    })
    expect(checks).toBe(0)
    kvReady = true
    await firstCheckStarted
    expect(checks).toBe(1)
    expect(commandFinished).toBe(false)
    resolveFirstCheck?.({ currentVersion: "0.2.0", version: "0.2.1" })
    await commandRun

    expect(updateStatusLabel("0.2.2")).toBe("0.2.2 available")
    expect(toasts).toEqual([])
    expect(cache.get("plugin-update-check-v1")).toEqual({
      checkedAt: new Date("2026-08-11T12:00:00.000Z").valueOf(),
      currentVersion: "0.2.0",
      opencodeVersion: "1.18.15",
      availableVersion: "0.2.2",
    })

    expect(checks).toBe(2)
    expect(signals).toEqual([controller.signal, controller.signal])
    expect(scopeInputs).toEqual([{ projectConfigDirectory: "/project/.opencode", globalConfigDirectory: "/global" }])
    expect(dialogs).toEqual([
      {
        title: "Update PR tracker to 0.2.2",
        message: "opencode plugin @hcrosse/opencode-pr-tracker@0.2.2 --force\n\nRestart OpenCode after updating.",
      },
    ])
  })
})
