import { describe, expect, test } from "bun:test"

import { startSessionPolling, type PollScheduler, type SidebarPullRequest } from "../src/polling.js"
import {
  createGitHubClient,
  type AvailablePullRequestStatus,
  type GitHubClient,
  type ProcessRunner,
  type PullRequestState,
} from "../src/github.js"
import type { PullRequestUrl } from "../src/url.js"
import {
  attachment,
  available,
  githubStatuses,
  pullRequest,
  secondAttachment,
  secondPullRequest,
  stateStore,
} from "./tui-fixtures.js"

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

describe("session polling", () => {
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
        async getStack(requested) {
          return { ok: true, value: [requested] }
        },
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
        async getStack(requested) {
          return { ok: true, value: [requested] }
        },
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
      async getStack(requested) {
        return { ok: true, value: [requested] }
      },
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
                { tag: "Open", ci: "failed", isDraft: false, mergeability: "mergeable", blocker: "none" },
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
          calls === 1
            ? { tag: "Closed" }
            : { tag: "Open", ci: "pending", isDraft: false, mergeability: "mergeable", blocker: "none" },
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
    expect(latestState).toEqual({
      tag: "Open",
      ci: "pending",
      isDraft: false,
      mergeability: "mergeable",
      blocker: "none",
    })
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
    let currentTime = 0
    let latest: readonly SidebarPullRequest[] = []
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github: {
        async getStack(requested) {
          return { ok: true, value: [requested] }
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
                  tag: "GitHubAuthenticationRequired",
                  message: "GitHub CLI authentication required",
                  cause: new Error(),
                },
              }
        },
      },
      scheduler: new RecordingScheduler(),
      now: () => currentTime,
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

    currentTime = 299_999
    await polling.refresh()
    expect(latest[0]?.status.tag).toBe("Available")

    currentTime = 300_000
    await polling.refresh()
    expect(latest[0]?.status).toEqual({
      tag: "Unavailable",
      diagnostic: "GitHubAuthenticationRequired",
    })

    availableResponse = true
    await polling.refresh()

    expect(latest[0]?.status).toEqual(available())
  })

  test("clears failure age when an attachment is removed", async () => {
    let attached = true
    let availableResponse = true
    let currentTime = 0
    let latest: readonly SidebarPullRequest[] = []
    const polling = startSessionPolling({
      sessionID: "session",
      store: {
        ...stateStore(),
        async list() {
          return { ok: true, value: attached ? [attachment] : [] }
        },
      },
      github: {
        async getStack(requested) {
          return { ok: true, value: [requested] }
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
                  tag: "GitHubAuthenticationRequired",
                  message: "GitHub CLI authentication required",
                  cause: new Error(),
                },
              }
        },
      },
      scheduler: new RecordingScheduler(),
      now: () => currentTime,
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

    attached = false
    await polling.refresh()
    currentTime = 300_000
    attached = true
    availableResponse = true
    await polling.refresh()
    availableResponse = false
    await polling.refresh()

    expect(latest[0]?.status).toEqual({
      ...available(),
      stale: true,
      diagnostic: "GitHubAuthenticationRequired",
    })
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
})
