import type {
  GitHubCancelled,
  GitHubClient,
  GitHubFailure,
  PullRequestDiagnostic,
  PullRequestStackMembership,
  PullRequestStatus,
} from "./github.js"
import type { PullRequestAttachment, StateFailure, StateStore } from "./state.js"
import type { CanonicalPullRequestUrl, Result } from "./url.js"

export type SidebarPullRequest = Readonly<{
  attachment: PullRequestAttachment
  status: PullRequestStatus
  membership?: PullRequestStackMembership
}>

export type PollScheduler = Readonly<{
  setInterval(task: () => void, delay: number): unknown
  clearInterval(handle: unknown): void
}>

export type SessionPolling = Readonly<{
  start(): Promise<void>
  refresh(): Promise<void>
  forceRefresh(): Promise<SessionRefreshResult>
  stop(): void
}>

export type SessionRefreshResult = Result<"refreshed" | "no_attachments" | "stopped", StateFailure | GitHubFailure>

const pollIntervalMilliseconds = 60_000
const staleEscalationMilliseconds = 5 * 60_000

const defaultScheduler: PollScheduler = {
  setInterval: (task, delay) => globalThis.setInterval(task, delay),
  // SAFETY: this scheduler only receives handles returned by setInterval above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PollScheduler erases the host-specific handle type
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
}

export function startSessionPolling(
  input: Readonly<{
    sessionID: string
    store: StateStore
    github: GitHubClient
    scheduler?: PollScheduler
    now?: () => number
    publish(items: readonly SidebarPullRequest[]): void
    onStateFailure(failure: StateFailure): void
    onError(error: unknown): void
  }>,
): SessionPolling {
  const scheduler = input.scheduler ?? defaultScheduler
  const now = input.now ?? Date.now
  const statuses = new Map<CanonicalPullRequestUrl, PullRequestStatus>()
  const memberships = new Map<CanonicalPullRequestUrl, PullRequestStackMembership>()
  const failureStartedAt = new Map<CanonicalPullRequestUrl, number>()
  const controller = new AbortController()
  let timer: unknown
  let timerRegistered = false
  let stopped = false
  let inFlight: Promise<SessionRefreshResult> | undefined
  let queued:
    | {
        promise: Promise<SessionRefreshResult>
        resolve(result: SessionRefreshResult): void
        reject(error: unknown): void
      }
    | undefined

  function project(attachments: readonly PullRequestAttachment[]): SidebarPullRequest[] {
    return attachments.map((attachment) => {
      const membership = memberships.get(attachment.pullRequest.url)
      return {
        attachment,
        status: statuses.get(attachment.pullRequest.url) ?? { tag: "Unavailable" },
        ...(membership === undefined ? {} : { membership }),
      }
    })
  }

  async function poll(): Promise<SessionRefreshResult> {
    const attachments = await input.store.list(input.sessionID)
    if (stopped) return { ok: true, value: "stopped" }
    if (!attachments.ok) {
      input.publish([])
      input.onStateFailure(attachments.error)
      return attachments
    }

    const attachedUrls = new Set<CanonicalPullRequestUrl>(
      attachments.value.map((attachment) => attachment.pullRequest.url),
    )
    for (const url of statuses.keys()) {
      if (!attachedUrls.has(url)) {
        statuses.delete(url)
        memberships.delete(url)
        failureStartedAt.delete(url)
      }
    }
    for (const url of memberships.keys()) {
      if (!attachedUrls.has(url)) memberships.delete(url)
    }
    input.publish(project(attachments.value))
    if (attachments.value.length === 0) return { ok: true, value: "no_attachments" }

    const refreshable = attachments.value.filter((attachment) => {
      const previous = statuses.get(attachment.pullRequest.url)
      return previous?.tag !== "Available" || previous.state.tag !== "Merged"
    })
    const statusRequest = input.github.get(
      refreshable.map((attachment) => attachment.pullRequest),
      { signal: controller.signal },
    )
    const stackRequest = input.github.getStacks(
      attachments.value.map((attachment) => attachment.pullRequest),
      { signal: controller.signal },
    )
    const [statusResult, stackResult] = await Promise.allSettled([statusRequest, stackRequest])
    if (statusResult.status === "rejected") throw statusResult.reason
    if (stackResult.status === "rejected") throw stackResult.reason
    const batch = statusResult.value
    const stackBatch = stackResult.value
    if (stopped) return { ok: true, value: "stopped" }
    let batchDiagnostic: PullRequestDiagnostic | undefined
    let failure: GitHubFailure | undefined
    let cancellation: GitHubCancelled | undefined
    if (!batch.ok) {
      if (batch.error.tag === "GitHubCancelled") {
        cancellation = batch.error
      } else {
        batchDiagnostic = batch.error.tag === "GitHubBatchLimitExceeded" ? "GitHubUnavailable" : batch.error.tag
        failure = batch.error
      }
    }

    if (batch.ok || batch.error.tag !== "GitHubCancelled") {
      for (const [index, attachment] of refreshable.entries()) {
        const previous = statuses.get(attachment.pullRequest.url)
        const result = batch.ok ? batch.value[index] : undefined
        if (result?.ok) {
          statuses.set(attachment.pullRequest.url, result.value)
          failureStartedAt.delete(attachment.pullRequest.url)
          continue
        }
        const diagnostic = result === undefined ? (batchDiagnostic ?? "GitHubUnavailable") : result.error.tag
        if (result !== undefined && !result.ok) failure ??= result.error
        if (previous?.tag !== "Available") {
          statuses.set(attachment.pullRequest.url, { tag: "Unavailable", diagnostic })
          continue
        }

        const failedAt = failureStartedAt.get(attachment.pullRequest.url)
        const failedNow = now()
        if (failedAt === undefined) failureStartedAt.set(attachment.pullRequest.url, failedNow)
        statuses.set(
          attachment.pullRequest.url,
          failedAt !== undefined && failedNow - failedAt >= staleEscalationMilliseconds
            ? { tag: "Unavailable", diagnostic }
            : { ...previous, stale: true, diagnostic },
        )
      }
    }

    if (!stackBatch.ok) {
      if (stackBatch.error.tag === "GitHubCancelled") cancellation ??= stackBatch.error
      else failure ??= stackBatch.error
    } else {
      for (const [index, attachment] of attachments.value.entries()) {
        const result = stackBatch.value[index]
        if (result?.ok) memberships.set(attachment.pullRequest.url, result.value)
        else if (result !== undefined) failure ??= result.error
      }
    }

    if (!stopped) input.publish(project(attachments.value))
    if (failure !== undefined) return { ok: false, error: failure }
    if (cancellation !== undefined) return { ok: false, error: cancellation }
    return { ok: true, value: "refreshed" }
  }

  function startQueuedRefresh(): void {
    inFlight = undefined
    const next = queued
    queued = undefined
    if (next === undefined) return
    if (stopped) {
      next.resolve({ ok: true, value: "stopped" })
      return
    }
    void requestRefresh().then(
      (result) => next.resolve(result),
      (error: unknown) => next.reject(error),
    )
  }

  function requestRefresh(): Promise<SessionRefreshResult> {
    if (stopped) return Promise.resolve({ ok: true, value: "stopped" })
    if (inFlight) {
      if (queued !== undefined) return queued.promise
      let resolve!: (result: SessionRefreshResult) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<SessionRefreshResult>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
      })
      queued = { promise, resolve, reject }
      return promise
    }
    const current = poll()
    inFlight = current
    void current.then(startQueuedRefresh, startQueuedRefresh)
    return current
  }

  function scheduledRefresh(): Promise<void> {
    return requestRefresh().then(() => undefined)
  }

  return {
    start() {
      if (stopped) return Promise.resolve()
      if (!timerRegistered) {
        timer = scheduler.setInterval(() => {
          scheduledRefresh().catch(input.onError)
        }, pollIntervalMilliseconds)
        timerRegistered = true
      }
      return scheduledRefresh()
    },
    refresh: scheduledRefresh,
    forceRefresh: requestRefresh,
    stop() {
      if (stopped) return
      stopped = true
      controller.abort()
      if (timerRegistered) scheduler.clearInterval(timer)
    },
  }
}
