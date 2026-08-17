import { describe, expect, test } from "bun:test"

import { startSessionPolling, type PollScheduler, type SidebarPullRequest } from "../src/polling.js"
import {
  createGitHubClient,
  type AvailablePullRequestStatus,
  type GitHubClient,
  type GitHubStackBatch,
  type PullRequestStackMembership,
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

function deferred<T>(): Readonly<{
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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

  test("polls statuses and Stack membership concurrently for every attachment", async () => {
    const statusBatches: PullRequestUrl[][] = []
    const stackBatches: PullRequestUrl[][] = []
    const firstStatuses = deferred<Awaited<ReturnType<GitHubClient["get"]>>>()
    const firstStacks = deferred<Awaited<ReturnType<GitHubClient["getStacks"]>>>()
    let statusCalls = 0
    let stackCalls = 0
    let latest: readonly SidebarPullRequest[] = []
    const github: GitHubClient = {
      async getStack(requested) {
        return { ok: true, value: [requested] }
      },
      get(pullRequests) {
        statusBatches.push([...pullRequests])
        statusCalls += 1
        if (statusCalls === 1) return firstStatuses.promise
        return Promise.resolve({
          ok: true,
          value: pullRequests.map((value) => ({ ok: true, value: available(undefined, value) })),
        })
      },
      getStacks(pullRequests) {
        stackBatches.push([...pullRequests])
        stackCalls += 1
        if (stackCalls === 1) return firstStacks.promise
        return Promise.resolve({
          ok: true,
          value: pullRequests.map((value) => ({
            ok: true,
            value: { tag: "Standalone", pullRequest: value },
          })),
        })
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

    const initial = polling.start()
    await Promise.resolve()
    await Promise.resolve()
    const bothStartedBeforeRelease = statusCalls === 1 && stackCalls === 1

    firstStatuses.resolve({
      ok: true,
      value: [
        { ok: true, value: available({ tag: "Merged" }, pullRequest) },
        { ok: true, value: available(undefined, secondPullRequest) },
      ],
    })
    const stackMembership: PullRequestStackMembership = {
      tag: "Stack",
      id: "owner/repository:42",
      members: [pullRequest, secondPullRequest],
    }
    firstStacks.resolve({
      ok: true,
      value: [
        { ok: true, value: stackMembership },
        { ok: true, value: stackMembership },
      ],
    })
    await initial

    expect(bothStartedBeforeRelease).toBe(true)
    expect(statusBatches).toEqual([[pullRequest, secondPullRequest]])
    expect(stackBatches).toEqual([[pullRequest, secondPullRequest]])
    expect(latest.map((item) => item.membership?.tag)).toEqual(["Stack", "Stack"])

    await polling.refresh()

    expect(statusBatches).toEqual([[pullRequest, secondPullRequest], [secondPullRequest]])
    expect(stackBatches).toEqual([
      [pullRequest, secondPullRequest],
      [pullRequest, secondPullRequest],
    ])
    expect(latest.map((item) => item.membership?.tag)).toEqual(["Standalone", "Standalone"])
  })

  test("retains only valid Stack membership across outer and per-item failures", async () => {
    const outerFailure = {
      tag: "GitHubUnavailable",
      message: "GitHub status unavailable",
      cause: new Error("offline"),
    } as const
    const itemFailure = {
      tag: "InvalidGitHubResponse",
      message: "GitHub returned an invalid pull request response",
    } as const
    const stackMembership: PullRequestStackMembership = {
      tag: "Stack",
      id: "owner/repository:42",
      members: [pullRequest, secondPullRequest],
    }
    let stackCall = 0
    let latest: readonly SidebarPullRequest[] = []
    const github: GitHubClient = {
      async getStack(requested) {
        return { ok: true, value: [requested] }
      },
      async get(pullRequests) {
        return {
          ok: true,
          value: pullRequests.map((value) => ({ ok: true, value: available(undefined, value) })),
        }
      },
      async getStacks() {
        stackCall += 1
        if (stackCall === 1 || stackCall === 4) return { ok: false, error: outerFailure }
        if (stackCall === 3) {
          return {
            ok: true,
            value: [
              { ok: false, error: itemFailure },
              { ok: false, error: itemFailure },
            ],
          }
        }
        return {
          ok: true,
          value: [
            { ok: true, value: stackMembership },
            { ok: true, value: stackMembership },
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

    expect(await polling.forceRefresh()).toEqual({ ok: false, error: outerFailure })
    expect(latest.map((item) => item.status.tag)).toEqual(["Available", "Available"])
    expect(latest.map((item) => item.membership)).toEqual([undefined, undefined])

    expect(await polling.forceRefresh()).toEqual({ ok: true, value: "refreshed" })
    expect(latest.map((item) => item.membership?.tag)).toEqual(["Stack", "Stack"])

    expect(await polling.forceRefresh()).toEqual({ ok: false, error: itemFailure })
    expect(latest.map((item) => item.membership?.tag)).toEqual(["Stack", "Stack"])

    expect(await polling.forceRefresh()).toEqual({ ok: false, error: outerFailure })
    expect(latest.map((item) => item.membership?.tag)).toEqual(["Stack", "Stack"])
  })

  test("removes detached pull requests from the Stack membership cache", async () => {
    let attached = true
    let stackAvailable = true
    let latest: readonly SidebarPullRequest[] = []
    const github: GitHubClient = {
      async getStack(requested) {
        return { ok: true, value: [requested] }
      },
      async get(pullRequests) {
        return {
          ok: true,
          value: pullRequests.map((value) => ({ ok: true, value: available(undefined, value) })),
        }
      },
      async getStacks(pullRequests) {
        return stackAvailable
          ? {
              ok: true,
              value: pullRequests.map(() => ({
                ok: true,
                value: {
                  tag: "Stack",
                  id: "owner/repository:42",
                  members: [pullRequest, secondPullRequest],
                },
              })) satisfies GitHubStackBatch,
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
    const polling = startSessionPolling({
      sessionID: "session",
      store: {
        ...stateStore(),
        async list() {
          return { ok: true, value: attached ? [attachment] : [] }
        },
      },
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

    await polling.forceRefresh()
    expect(latest[0]?.membership?.tag).toBe("Stack")

    attached = false
    await polling.forceRefresh()
    attached = true
    stackAvailable = false
    await polling.forceRefresh()

    expect(latest[0]?.membership).toBeUndefined()
  })

  test("applies successful batch items while retaining failed items as stale", async () => {
    let calls = 0
    let latest: readonly SidebarPullRequest[] = []
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

  test("waits for a pending sibling request before starting a queued refresh after rejection", async () => {
    const statusFailure = new Error("unexpected status failure")
    const firstStatuses = deferred<Awaited<ReturnType<GitHubClient["get"]>>>()
    const firstStacks = deferred<Awaited<ReturnType<GitHubClient["getStacks"]>>>()
    const firstBatchStarted = deferred<void>()
    let statusCalls = 0
    let stackCalls = 0
    const markFirstBatchStarted = () => {
      if (statusCalls === 1 && stackCalls === 1) firstBatchStarted.resolve()
    }
    const github: GitHubClient = {
      async getStack(requested) {
        return { ok: true, value: [requested] }
      },
      get(pullRequests) {
        statusCalls += 1
        markFirstBatchStarted()
        if (statusCalls === 1) return firstStatuses.promise
        return Promise.resolve({
          ok: true,
          value: pullRequests.map((value) => ({ ok: true, value: available(undefined, value) })),
        })
      },
      getStacks(pullRequests) {
        stackCalls += 1
        markFirstBatchStarted()
        if (stackCalls === 1) return firstStacks.promise
        return Promise.resolve({
          ok: true,
          value: pullRequests.map((value) => ({
            ok: true,
            value: { tag: "Standalone", pullRequest: value },
          })),
        })
      },
    }
    const polling = startSessionPolling({
      sessionID: "session",
      store: stateStore(),
      github,
      scheduler: new RecordingScheduler(),
      publish: () => undefined,
      onStateFailure: () => undefined,
      onError: () => undefined,
    })

    let leadingSettled = false
    const leading = polling.forceRefresh().catch((error: unknown) => {
      leadingSettled = true
      return error
    })
    const trailing = polling.forceRefresh()
    await firstBatchStarted.promise
    firstStatuses.reject(statusFailure)
    await Bun.sleep(0)

    expect(leadingSettled).toBe(false)
    expect([statusCalls, stackCalls]).toEqual([1, 1])

    firstStacks.resolve({
      ok: true,
      value: [{ ok: true, value: { tag: "Standalone", pullRequest } }],
    })

    expect(await leading).toBe(statusFailure)
    expect(await trailing).toEqual({ ok: true, value: "refreshed" })
    expect([statusCalls, stackCalls]).toEqual([2, 2])
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
