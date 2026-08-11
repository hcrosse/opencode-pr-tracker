import { describe, expect, test } from "bun:test"

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

import {
  attachPullRequest,
  openPullRequest,
  registerTui,
  startSessionPolling,
  type PollScheduler,
} from "../src/tui.jsx"
import type { AvailablePullRequestStatus, GitHubClient, ProcessRunner } from "../src/github.js"
import type { PullRequestAttachment, StateStore } from "../src/state.js"
import { parsePullRequestUrl, type CanonicalPullRequestUrl } from "../src/url.js"

const parsed = parsePullRequestUrl("https://github.com/owner/repository/pull/42")
if (!parsed.ok) throw new Error("test fixture URL is invalid")
const pullRequest = parsed.value
const canonicalPullRequestUrl: CanonicalPullRequestUrl = pullRequest.url
const attachment: PullRequestAttachment = {
  pullRequest,
  attachedAt: "2026-08-10T12:00:00.000Z",
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
  }
}

function available(overrides: Partial<AvailablePullRequestStatus> = {}): AvailablePullRequestStatus {
  return {
    tag: "Available",
    pullRequest,
    title: "Track pull requests",
    lifecycle: "open",
    ci: "passed",
    stale: false,
    ...overrides,
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

describe("TUI orchestration", () => {
  test("registers model-free slash commands and the sidebar slot", () => {
    let layer: { commands: Array<{ name: string; slashName?: string }> } | undefined
    let slots: Record<string, unknown> | undefined
    const disposers: Array<() => void> = []
    const events: string[] = []
    const api = {
      keymap: {
        registerLayer(value: typeof layer) {
          layer = value
          return () => undefined
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
        on(type: string) {
          events.push(type)
          return () => undefined
        },
      },
    } as unknown as TuiPluginApi

    registerTui(api, { store: stateStore(), github: { get: async () => ({ ok: true, value: available() }) } })

    expect(layer?.commands.map(({ name, slashName }) => ({ name, slashName }))).toEqual([
      { name: "pr.attach", slashName: "pr-attach" },
      { name: "pr.detach", slashName: "pr-detach" },
    ])
    expect(slots).toHaveProperty("sidebar_content")
    expect(disposers).toHaveLength(1)
    expect(events).toEqual(["session.updated", "message.updated", "message.part.updated"])
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

  test("polls immediately every sixty seconds and stops cleanly", async () => {
    const scheduler = new RecordingScheduler()
    const published: unknown[] = []
    let calls = 0
    const github: GitHubClient = {
      async get() {
        calls += 1
        return { ok: true, value: available() }
      },
    }
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

  test("does not repoll terminal pull requests", async () => {
    let calls = 0
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github: {
        async get() {
          calls += 1
          return { ok: true, value: available({ lifecycle: "merged", ci: "failed" }) }
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
    await polling.refresh()

    expect(calls).toBe(1)
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
      github: {
        async get() {
          calls += 1
          return { ok: true, value: calls === 1 ? await first : available() }
        },
      },
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

  test("retains the last successful status and marks it stale", async () => {
    let availableResponse = true
    let latest: readonly { status: { tag: string; stale?: boolean } }[] = []
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github: {
        async get() {
          return availableResponse
            ? { ok: true, value: available() }
            : {
                ok: false,
                error: { tag: "GitHubUnavailable", message: "GitHub status unavailable", cause: new Error() },
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

    expect(latest[0]?.status).toMatchObject({ tag: "Available", stale: true })
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
      github: {
        async get() {
          return { ok: true, value: available() }
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
})
