import { describe, expect, test } from "bun:test"

import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { jsx } from "@opentui/solid/jsx-runtime"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

import {
  attachPullRequest,
  createPullRequestCommands,
  createRefreshBus,
  PullRequestSidebar,
  type PullRequestTuiDependencies,
  type RefreshBus,
} from "../src/pull-request-tui.js"
import type { GitHubClient, ProcessRunner } from "../src/github.js"
import type { PullRequestAttachment, StateStore } from "../src/state.js"
import { parsePullRequestUrl, type PullRequestUrl } from "../src/url.js"
import { attachment, githubStatuses, pullRequest, secondAttachment, stateStore } from "./tui-fixtures.js"

const thirdParsed = parsePullRequestUrl("https://github.com/third/example/pull/9")
if (!thirdParsed.ok) throw new Error("third test fixture URL is invalid")
const thirdAttachment: PullRequestAttachment = {
  pullRequest: thirdParsed.value,
  attachedAt: "2026-08-10T12:02:00.000Z",
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
  options: Readonly<{ followingText?: string }> = {},
) {
  let githubCalls = 0
  const color = RGBA.fromHex("#ffffff")
  const github = githubStatuses()
  const refreshBus = createRefreshBus()
  const api = {
    lifecycle: {
      signal: new AbortController().signal,
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
  } as unknown as TuiPluginApi
  const dependencies = {
    store: stateStore(items),
    github: {
      async getStack(requested) {
        return { ok: true, value: [requested] }
      },
      async get(...args) {
        githubCalls += 1
        return github.get(...args)
      },
    },
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
          }),
          options.followingText ? jsx("text", { children: options.followingText }) : null,
        ],
      }),
    { width: 80, height: 20 },
  )
  await view.waitForFrame((frame) => frame.includes("Pull requests"))
  if (items.length > 0) await view.waitFor(() => githubCalls === 1)
  await view.renderOnce()

  return {
    view,
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
      expect(firstReference.slice(firstBulletColumn)).toStartWith("• owner/repository#42")
      expect(firstTitle.indexOf("Track pull requests")).toBe(firstBulletColumn + 2)
      expect(secondReference.slice(secondBulletColumn)).toStartWith("• another/project#7")
      expect(secondTitle.indexOf("Track pull requests")).toBe(secondBulletColumn + 2)
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
