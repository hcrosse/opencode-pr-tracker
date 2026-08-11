import { describe, expect, test } from "bun:test"

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

import {
  attachPullRequest,
  openPullRequest,
  registerTui,
  startSessionPolling,
  updateStatusLabel,
  type PollScheduler,
  type SidebarPullRequest,
} from "../src/tui.jsx"
import {
  createGitHubClient,
  type AvailablePullRequestStatus,
  type GitHubClient,
  type ProcessRunner,
  type PullRequestState,
} from "../src/github.js"
import type { PullRequestAttachment, StateStore } from "../src/state.js"
import { parsePullRequestUrl, type CanonicalPullRequestUrl, type PullRequestUrl } from "../src/url.js"

const parsed = parsePullRequestUrl("https://github.com/owner/repository/pull/42")
if (!parsed.ok) throw new Error("test fixture URL is invalid")
const pullRequest = parsed.value
const secondParsed = parsePullRequestUrl("https://github.com/another/project/pull/7")
if (!secondParsed.ok) throw new Error("second test fixture URL is invalid")
const secondPullRequest = secondParsed.value
const canonicalPullRequestUrl: CanonicalPullRequestUrl = pullRequest.url
const attachment: PullRequestAttachment = {
  pullRequest,
  attachedAt: "2026-08-10T12:00:00.000Z",
}
const secondAttachment: PullRequestAttachment = {
  pullRequest: secondPullRequest,
  attachedAt: "2026-08-10T12:01:00.000Z",
}

function stateStore(items: readonly PullRequestAttachment[] = [attachment]): StateStore {
  return {
    async list() {
      return { ok: true, value: items }
    },
    async attach() {
      return { ok: true, value: "added" }
    },
    async detach() {
      return { ok: true, value: "removed" }
    },
    async detachByNumber() {
      return { ok: true, value: { tag: "absent" } }
    },
    async removeSession() {
      return { ok: true, value: "absent" }
    },
  }
}

function available(
  state: PullRequestState = { tag: "Open", ci: "passed", mergeability: "mergeable", blocker: "none" },
  value: PullRequestUrl = pullRequest,
): AvailablePullRequestStatus {
  return {
    tag: "Available",
    pullRequest: value,
    title: "Track pull requests",
    state,
    stale: false,
  }
}

function githubStatuses(
  resolve: (pullRequest: PullRequestUrl) => AvailablePullRequestStatus | Promise<AvailablePullRequestStatus> = (
    value,
  ) => available(undefined, value),
): GitHubClient {
  return {
    async get(pullRequests) {
      return {
        ok: true,
        value: await Promise.all(
          pullRequests.map(async (value) => ({ ok: true, value: await resolve(value) }) as const),
        ),
      }
    },
  }
}

class RecordingScheduler implements PollScheduler {
  delay: number | undefined
  task: (() => void) | undefined
  cleared = false

  setInterval(task: () => void, delay: number): object {
    this.task = task
    this.delay = delay
    return {}
  }

  clearInterval(): void {
    this.cleared = true
  }
}

class UndefinedHandleScheduler implements PollScheduler {
  intervals = 0
  cleared: unknown[] = []

  setInterval(): undefined {
    this.intervals += 1
    return undefined
  }

  clearInterval(handle: unknown): void {
    this.cleared.push(handle)
  }
}

describe("TUI orchestration", () => {
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

    registerTui(api, { store: stateStore(), github: githubStatuses() })

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

  test("shows minimal update status and scoped instructions without installing", async () => {
    type Command = Readonly<{ name: string; run(): Promise<void> }>
    const commands = new Map<string, Command>()
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

    registerTui(
      api,
      {
        store: stateStore(),
        github: githubStatuses(),
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
    const commandRun = commands
      .get("pr.tracker.plugin.update")!
      .run()
      .then(() => {
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

  test("validates and attaches manual input through the shared state store", async () => {
    const attached: string[] = []
    const store: StateStore = {
      ...stateStore([]),
      async attach(sessionID, value) {
        attached.push(`${sessionID}:${value.url}`)
        return { ok: true, value: "added" }
      },
    }

    expect(await attachPullRequest(store, "session", "https://example.com/pull/1")).toMatchObject({
      ok: false,
      error: { tag: "InvalidPullRequestUrl" },
    })
    expect(await attachPullRequest(store, "session", canonicalPullRequestUrl)).toEqual({ ok: true, value: "added" })
    expect(attached).toEqual([`session:${canonicalPullRequestUrl}`])
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
      async attach(sessionID, value) {
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

    registerTui(api, { store, github: githubStatuses(), runner })

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

    registerTui(api, { store, github: githubStatuses(), runner })

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

    registerTui(api, { store, github: githubStatuses(), runner })

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

    registerTui(api, { store, github: githubStatuses() })

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
    const processCalls: Array<{ file: string; args: readonly string[]; signal: AbortSignal | undefined }> = []
    let attachCalls = 0
    let detachCalls = 0
    const store: StateStore = {
      async list() {
        return { ok: true, value: [attachment] }
      },
      async attach() {
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
          options: readonly { value: PullRequestUrl }[]
          onSelect(value: { value: PullRequestUrl }): void
        }) {
          dialogTitles.push(props.title)
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

    registerTui(api, { store, github: githubStatuses(), runner })

    await commands.get("pr.attach")!.run()
    await commands.get("pr.attach")!.run()
    await commands.get("pr.open")!.run()
    await commands.get("pr.detach")!.run()
    await commands.get("pr.detach")!.run()

    expect(dialogTitles).toEqual(["Open pull request", "Detach pull request", "Detach pull request"])
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

    registerTui(api, { store: stateStore([]), github: githubStatuses() })

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

    registerTui(api, { store, github: githubStatuses(), refreshBus })

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

    registerTui(api, { store: stateStore(), github: githubStatuses(), refreshBus })

    const sync = commands.get("pr.sync")!.run()
    await refreshStarted
    expect(toasts).toEqual([])
    finishRefresh?.()
    await sync

    expect(requestedSessions).toEqual(["session"])
    expect(toasts).toEqual(["Pull request status synced"])
  })

  test("reports forced polling failures", async () => {
    const stateFailure = {
      tag: "InvalidStateFile",
      message: "The session pull request state file is invalid",
    } as const
    const statePolling = startSessionPolling({
      sessionID: "session",
      store: {
        ...stateStore(),
        async list() {
          return { ok: false, error: stateFailure }
        },
      },
      github: githubStatuses(),
      scheduler: new RecordingScheduler(),
      publish: () => undefined,
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })
    const githubFailure = {
      tag: "GitHubUnavailable",
      message: "GitHub status unavailable",
      cause: new Error("offline"),
    } as const
    const githubPolling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github: {
        async get() {
          return { ok: false, error: githubFailure }
        },
      },
      scheduler: new RecordingScheduler(),
      publish: () => undefined,
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })

    expect(await statePolling.forceRefresh()).toEqual({ ok: false, error: stateFailure })
    expect(await githubPolling.forceRefresh()).toEqual({ ok: false, error: githubFailure })
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

    registerTui(api, { store, github: githubStatuses(), runner })

    await commands.get("pr.open")!.run()
    readable = true
    await commands.get("pr.open")!.run()

    expect(toasts).toEqual(["The session pull request state file is invalid", "Unable to open the pull request"])
  })

  test("polls immediately every sixty seconds and stops cleanly", async () => {
    const scheduler = new RecordingScheduler()
    const published: unknown[] = []
    let calls = 0
    const github = githubStatuses(() => {
      calls += 1
      return available()
    })
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github,
      scheduler,
      publish: (items) => published.push(items),
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })

    await polling.start()

    expect(calls).toBe(1)
    expect(scheduler.delay).toBe(60_000)
    expect(published).toHaveLength(2)
    polling.stop()
    expect(scheduler.cleared).toBe(true)
  })

  test("refreshes multiple attachments in one GitHub batch", async () => {
    const batches: PullRequestUrl[][] = []
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore([attachment, secondAttachment]),
      github: {
        async get(pullRequests) {
          batches.push([...pullRequests])
          return {
            ok: true,
            value: pullRequests.map((value) => ({ ok: true, value: available(undefined, value) })),
          }
        },
      },
      scheduler: new RecordingScheduler(),
      publish: () => undefined,
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })

    await polling.start()

    expect(batches).toEqual([[pullRequest, secondPullRequest]])
  })

  test("applies successful batch items while retaining failed items as stale", async () => {
    let calls = 0
    let latest: readonly SidebarPullRequest[] = []
    const github: GitHubClient = {
      async get(pullRequests) {
        calls += 1
        if (calls === 1) {
          return {
            ok: true,
            value: pullRequests.map((value) => ({ ok: true, value: available(undefined, value) })),
          }
        }
        return {
          ok: true,
          value: [
            {
              ok: true,
              value: available(
                { tag: "Open", ci: "failed", mergeability: "mergeable", blocker: "none" },
                pullRequests[0],
              ),
            },
            {
              ok: false,
              error: {
                tag: "InvalidGitHubResponse",
                message: "GitHub returned an invalid pull request response",
              },
            },
          ],
        }
      },
    }
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore([attachment, secondAttachment]),
      github,
      scheduler: new RecordingScheduler(),
      publish: (items) => {
        latest = items
      },
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })

    await polling.start()
    await polling.refresh()

    expect(latest.map((item) => item.status)).toMatchObject([
      {
        tag: "Available",
        state: { tag: "Open", ci: "failed", mergeability: "mergeable", blocker: "none" },
        stale: false,
      },
      {
        tag: "Available",
        state: { tag: "Open", ci: "passed", mergeability: "mergeable", blocker: "none" },
        stale: true,
        diagnostic: "InvalidGitHubResponse",
      },
    ])
  })

  test("stop aborts an in-flight GitHub request without publishing its result", async () => {
    let requestSignal: AbortSignal | undefined
    let requestStarted: (() => void) | undefined
    let releaseRequest: ((value: { stdout: string }) => void) | undefined
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve
    })
    const runner: ProcessRunner = (_file, _args, options) =>
      new Promise((resolve, reject) => {
        requestSignal = options.signal
        releaseRequest = resolve
        requestStarted?.()
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    const published: unknown[] = []
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github: createGitHubClient(runner),
      scheduler: new RecordingScheduler(),
      publish: (items) => published.push(items),
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })

    const initial = polling.start()
    await started
    polling.stop()
    releaseRequest?.({ stdout: "{}" })
    await initial

    expect(requestSignal?.aborted).toBe(true)
    expect(published).toHaveLength(1)
  })

  test("owns one interval when the scheduler handle is undefined", async () => {
    const scheduler = new UndefinedHandleScheduler()
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore([]),
      github: githubStatuses(),
      scheduler,
      publish: () => undefined,
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })

    await polling.start()
    await polling.start()
    polling.stop()
    polling.stop()

    expect(scheduler.intervals).toBe(1)
    expect(scheduler.cleared).toEqual([undefined])
  })

  test("does not register an interval after polling stops", async () => {
    const scheduler = new UndefinedHandleScheduler()
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore([]),
      github: githubStatuses(),
      scheduler,
      publish: () => undefined,
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })

    polling.stop()
    await polling.start()

    expect(scheduler.intervals).toBe(0)
  })

  test("does not force refresh merged pull requests", async () => {
    let calls = 0
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github: githubStatuses(() => {
        calls += 1
        return available({ tag: "Merged" })
      }),
      scheduler: new RecordingScheduler(),
      publish: () => undefined,
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })

    await polling.start()
    await polling.refresh()
    await polling.forceRefresh()

    expect(calls).toBe(1)
  })

  test("rechecks closed pull requests and observes reopening", async () => {
    let calls = 0
    let latestState: PullRequestState | undefined
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github: githubStatuses(() => {
        calls += 1
        return available(
          calls === 1 ? { tag: "Closed" } : { tag: "Open", ci: "pending", mergeability: "mergeable", blocker: "none" },
        )
      }),
      scheduler: new RecordingScheduler(),
      publish: (items) => {
        const status = items[0]?.status
        if (status?.tag === "Available") latestState = status.state
      },
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })

    await polling.start()
    await polling.refresh()

    expect(calls).toBe(2)
    expect(latestState).toEqual({ tag: "Open", ci: "pending", mergeability: "mergeable", blocker: "none" })
  })

  test("queues one trailing refresh requested during an active poll", async () => {
    let calls = 0
    let resolveFirst: ((value: ReturnType<typeof available>) => void) | undefined
    const first = new Promise<AvailablePullRequestStatus>((resolve) => {
      resolveFirst = resolve
    })
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github: githubStatuses(async () => {
        calls += 1
        return calls === 1 ? await first : available()
      }),
      scheduler: new RecordingScheduler(),
      publish: () => undefined,
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })

    const initial = polling.start()
    const trailing = polling.refresh()
    resolveFirst?.(available())
    await Promise.all([initial, trailing])

    expect(calls).toBe(2)
  })

  test("coalesces forced requests into one awaited trailing refresh", async () => {
    let calls = 0
    let resolveFirst: ((value: ReturnType<typeof available>) => void) | undefined
    let resolveSecond: ((value: ReturnType<typeof available>) => void) | undefined
    let markSecondStarted: (() => void) | undefined
    const first = new Promise<AvailablePullRequestStatus>((resolve) => {
      resolveFirst = resolve
    })
    const second = new Promise<AvailablePullRequestStatus>((resolve) => {
      resolveSecond = resolve
    })
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve
    })
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github: githubStatuses(async () => {
        calls += 1
        if (calls === 1) return await first
        markSecondStarted?.()
        return await second
      }),
      scheduler: new RecordingScheduler(),
      publish: () => undefined,
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })

    const initial = polling.start()
    const firstForced = polling.forceRefresh()
    const secondForced = polling.forceRefresh()
    let completed = false
    const firstCompletion = firstForced.then(() => {
      completed = true
    })
    resolveFirst?.(available())
    await secondStarted

    expect(completed).toBe(false)
    resolveSecond?.(available())
    await Promise.all([initial, firstCompletion, secondForced])
    expect(calls).toBe(2)
  })

  test("reports the forced trailing result after an active poll rejects", async () => {
    const leadingFailure = new Error("leading poll failed")
    let rejectFirst: ((error: Error) => void) | undefined
    let calls = 0
    const first = new Promise<AvailablePullRequestStatus>((_resolve, reject) => {
      rejectFirst = reject
    })
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github: githubStatuses(async () => {
        calls += 1
        return calls === 1 ? await first : available()
      }),
      scheduler: new RecordingScheduler(),
      publish: () => undefined,
      onStateFailure: () => undefined,
      onError: () => undefined,
    })

    const initial = polling.start().catch((error: unknown) => error)
    const forced = polling.forceRefresh()
    rejectFirst?.(leadingFailure)

    expect(await forced).toEqual({ ok: true, value: "refreshed" })
    expect(await initial).toBe(leadingFailure)
    expect(calls).toBe(2)
  })

  test("resolves a queued forced refresh as stopped", async () => {
    let resolveFirst: ((value: ReturnType<typeof available>) => void) | undefined
    let calls = 0
    const first = new Promise<AvailablePullRequestStatus>((resolve) => {
      resolveFirst = resolve
    })
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github: githubStatuses(async () => {
        calls += 1
        return await first
      }),
      scheduler: new RecordingScheduler(),
      publish: () => undefined,
      onStateFailure: () => undefined,
      onError: () => undefined,
    })

    const initial = polling.start()
    const forced = polling.forceRefresh()
    polling.stop()
    resolveFirst?.(available())

    await initial
    expect(await forced).toEqual({ ok: true, value: "stopped" })
    expect(calls).toBe(0)
  })

  test("retains stale diagnostics and clears them after a successful refresh", async () => {
    let availableResponse = true
    let latest: readonly SidebarPullRequest[] = []
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github: {
        async get(pullRequests) {
          return availableResponse
            ? {
                ok: true,
                value: pullRequests.map((value) => ({ ok: true, value: available(undefined, value) })),
              }
            : {
                ok: false,
                error: {
                  tag: "GitHubAuthenticationRequired",
                  message: "GitHub CLI authentication required",
                  cause: new Error(),
                },
              }
        },
      },
      scheduler: new RecordingScheduler(),
      publish: (items) => {
        latest = items
      },
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })

    await polling.start()
    availableResponse = false
    await polling.refresh()

    expect(latest[0]?.status).toEqual({
      ...available(),
      stale: true,
      diagnostic: "GitHubAuthenticationRequired",
    })

    availableResponse = true
    await polling.refresh()

    expect(latest[0]?.status).toEqual(available())
  })

  test("clears published rows when persisted state becomes unreadable", async () => {
    let readable = true
    let latest: readonly unknown[] = []
    const polling = startSessionPolling({
      sessionID: "session",
      store: {
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
      },
      github: githubStatuses(),
      scheduler: new RecordingScheduler(),
      publish: (items) => {
        latest = items
      },
      onStateFailure: () => undefined,
      onError: (error) => {
        throw error
      },
    })

    await polling.start()
    readable = false
    await polling.refresh()

    expect(latest).toEqual([])
  })

  test.each([
    { platform: "darwin", executable: "open" },
    { platform: "linux", executable: "xdg-open" },
  ])("opens a validated URL with $executable on $platform", async ({ platform, executable }) => {
    const calls: Array<{ file: string; args: readonly string[] }> = []
    const runner: ProcessRunner = async (file, args) => {
      calls.push({ file, args })
      return { stdout: "" }
    }

    expect(await openPullRequest(pullRequest, { platform, runner })).toEqual({ ok: true, value: undefined })
    expect(calls).toEqual([{ file: executable, args: [pullRequest.url] }])
  })

  test("preserves the unsupported-platform message", async () => {
    const result = await openPullRequest(pullRequest, { platform: "win32" })

    expect(result).toEqual({
      ok: false,
      error: {
        tag: "UnsupportedPlatform",
        message: "Opening pull requests is unsupported on win32",
        platform: "win32",
      },
    })
  })

  test("preserves the browser process failure message", async () => {
    const cause = new Error("process failed")
    const runner: ProcessRunner = async () => {
      throw cause
    }

    expect(await openPullRequest(pullRequest, { platform: "darwin", runner })).toEqual({
      ok: false,
      error: {
        tag: "OpenPullRequestFailed",
        message: "Unable to open the pull request",
        cause,
      },
    })
  })
})
