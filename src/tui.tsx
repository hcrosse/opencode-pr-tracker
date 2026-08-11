/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"

import { resolvePullRequestInput } from "./attach.js"
import {
  createGitHubClient,
  execFileRunner,
  statusAppearance,
  type GitHubClient,
  type ProcessRunner,
  type PullRequestStatus,
} from "./github.js"
import {
  createStateStore,
  type AttachFailure,
  type PullRequestAttachment,
  type StateFailure,
  type StateStore,
} from "./state.js"
import {
  formatPullRequestRef,
  parsePullRequestUrl,
  type CanonicalPullRequestUrl,
  type InvalidPullRequestUrl,
  type PullRequestUrl,
  type Result,
} from "./url.js"

export type SidebarPullRequest = Readonly<{
  attachment: PullRequestAttachment
  status: PullRequestStatus
}>

export type PollScheduler = Readonly<{
  setInterval(task: () => void, delay: number): unknown
  clearInterval(handle: unknown): void
}>

export type SessionPolling = Readonly<{
  start(): Promise<void>
  refresh(): Promise<void>
  stop(): void
}>

const pollIntervalMilliseconds = 60_000

const defaultScheduler: PollScheduler = {
  setInterval: (task, delay) => globalThis.setInterval(task, delay),
  // SAFETY: this scheduler only receives handles returned by setInterval above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PollScheduler erases the host-specific handle type
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
}

export function attachPullRequest(
  store: StateStore,
  sessionID: string,
  input: string,
): Promise<Result<"added" | "already_attached", InvalidPullRequestUrl | AttachFailure>> {
  const pullRequest = parsePullRequestUrl(input)
  if (!pullRequest.ok) return Promise.resolve(pullRequest)
  return store.attach(sessionID, pullRequest.value)
}

export function startSessionPolling(
  input: Readonly<{
    sessionID: string
    store: StateStore
    github: GitHubClient
    scheduler?: PollScheduler
    publish(items: readonly SidebarPullRequest[]): void
    onStateFailure(failure: StateFailure): void
    onError(error: unknown): void
  }>,
): SessionPolling {
  const scheduler = input.scheduler ?? defaultScheduler
  const statuses = new Map<CanonicalPullRequestUrl, PullRequestStatus>()
  const controller = new AbortController()
  let timer: unknown
  let timerRegistered = false
  let stopped = false
  let inFlight: Promise<void> | undefined
  let refreshQueued = false

  function project(attachments: readonly PullRequestAttachment[]): SidebarPullRequest[] {
    return attachments.map((attachment) => ({
      attachment,
      status: statuses.get(attachment.pullRequest.url) ?? { tag: "Unavailable" },
    }))
  }

  async function poll(): Promise<void> {
    const attachments = await input.store.list(input.sessionID)
    if (stopped) return
    if (!attachments.ok) {
      input.publish([])
      input.onStateFailure(attachments.error)
      return
    }

    const attachedUrls = new Set<CanonicalPullRequestUrl>(
      attachments.value.map((attachment) => attachment.pullRequest.url),
    )
    for (const url of statuses.keys()) {
      if (!attachedUrls.has(url)) statuses.delete(url)
    }
    input.publish(project(attachments.value))

    const refreshable = attachments.value.filter((attachment) => {
      const previous = statuses.get(attachment.pullRequest.url)
      return previous?.tag !== "Available" || previous.state.tag !== "Merged"
    })
    const batch = await input.github.get(
      refreshable.map((attachment) => attachment.pullRequest),
      { signal: controller.signal },
    )
    if (stopped || (!batch.ok && batch.error.tag === "GitHubCancelled")) return

    for (const [index, attachment] of refreshable.entries()) {
      const previous = statuses.get(attachment.pullRequest.url)
      const result = batch.ok ? batch.value[index] : undefined
      if (result?.ok) {
        statuses.set(attachment.pullRequest.url, result.value)
        continue
      }
      statuses.set(
        attachment.pullRequest.url,
        previous?.tag === "Available" ? { ...previous, stale: true } : { tag: "Unavailable" },
      )
    }

    if (!stopped) input.publish(project(attachments.value))
  }

  function refresh(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (inFlight) {
      refreshQueued = true
      return inFlight
    }
    const wrapped = poll().finally(() => {
      inFlight = undefined
      if (refreshQueued && !stopped) {
        refreshQueued = false
        return refresh()
      }
      return undefined
    })
    inFlight = wrapped
    return wrapped
  }

  return {
    start() {
      if (stopped) return Promise.resolve()
      if (!timerRegistered) {
        timer = scheduler.setInterval(() => {
          refresh().catch(input.onError)
        }, pollIntervalMilliseconds)
        timerRegistered = true
      }
      return refresh()
    },
    refresh,
    stop() {
      if (stopped) return
      stopped = true
      controller.abort()
      if (timerRegistered) scheduler.clearInterval(timer)
    },
  }
}

export type OpenPullRequestFailure =
  | Readonly<{
      tag: "UnsupportedPlatform"
      message: string
      platform: string
    }>
  | Readonly<{
      tag: "OpenPullRequestFailed"
      message: "Unable to open the pull request"
      cause: unknown
    }>

export async function openPullRequest(
  pullRequest: PullRequestUrl,
  options: Readonly<{
    platform?: string
    runner?: ProcessRunner
    signal?: AbortSignal
  }> = {},
): Promise<Result<void, OpenPullRequestFailure>> {
  const platform = options.platform ?? process.platform
  const executable = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : undefined
  if (executable === undefined) {
    return {
      ok: false,
      error: {
        tag: "UnsupportedPlatform",
        message: `Opening pull requests is unsupported on ${platform}`,
        platform,
      },
    }
  }

  try {
    await (options.runner ?? execFileRunner)(
      executable,
      [pullRequest.url],
      options.signal ? { signal: options.signal } : {},
    )
    return { ok: true, value: undefined }
  } catch (cause) {
    return {
      ok: false,
      error: { tag: "OpenPullRequestFailed", message: "Unable to open the pull request", cause },
    }
  }
}

type RefreshBus = Readonly<{
  emit(sessionID: string): void
  subscribe(sessionID: string, listener: () => void): () => void
}>

function createRefreshBus(): RefreshBus {
  const listeners = new Map<string, Set<() => void>>()
  return {
    emit(sessionID) {
      for (const listener of listeners.get(sessionID) ?? []) listener()
    },
    subscribe(sessionID, listener) {
      const sessionListeners = listeners.get(sessionID) ?? new Set()
      sessionListeners.add(listener)
      listeners.set(sessionID, sessionListeners)
      return () => {
        sessionListeners.delete(listener)
        if (sessionListeners.size === 0) listeners.delete(sessionID)
      }
    },
  }
}

function currentSessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  if (route.name !== "session" || !("params" in route)) return undefined
  return typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
}

function promptForPullRequest(
  api: TuiPluginApi,
  options: Readonly<{
    directory: string
    runner?: ProcessRunner
    signal: AbortSignal
  }>,
): Promise<PullRequestUrl | undefined> {
  return new Promise((resolve) => {
    const controller = new AbortController()
    const signal = AbortSignal.any([options.signal, controller.signal])
    let finished = false
    const finish = (value: PullRequestUrl | undefined) => {
      if (finished) return
      finished = true
      controller.abort()
      api.ui.dialog.clear()
      resolve(value)
    }

    api.ui.dialog.setSize("medium")
    api.ui.dialog.replace(
      () => {
        const [error, setError] = createSignal<string>()
        const [busy, setBusy] = createSignal(false)
        const DialogPrompt = api.ui.DialogPrompt
        return (
          <DialogPrompt
            title="Attach pull request"
            placeholder="https://github.com/owner/repository/pull/123 or 123"
            description={() => (error() ? <text fg={api.theme.current.error}>{error()}</text> : null)}
            busy={busy()}
            busyText="Resolving repository"
            onConfirm={(value) => {
              if (busy()) return
              setBusy(true)
              void resolvePullRequestInput(value, {
                directory: options.directory,
                ...(options.runner ? { runner: options.runner } : {}),
                signal,
              }).then((result) => {
                if (finished) return
                setBusy(false)
                if (result.ok) {
                  finish(result.value)
                  return
                }
                if (result.error.tag === "RepositoryResolutionCancelled") {
                  finish(undefined)
                  return
                }
                setError(result.error.message)
              })
            }}
            onCancel={() => finish(undefined)}
          />
        )
      },
      () => {
        if (finished) return
        finished = true
        controller.abort()
        resolve(undefined)
      },
    )
  })
}

function selectPullRequest(
  api: TuiPluginApi,
  title: "Open pull request" | "Detach pull request",
  attachments: readonly PullRequestAttachment[],
): Promise<PullRequestUrl | undefined> {
  return new Promise((resolve) => {
    let finished = false
    const finish = (value: PullRequestUrl | undefined) => {
      if (finished) return
      finished = true
      api.ui.dialog.clear()
      resolve(value)
    }

    api.ui.dialog.setSize("medium")
    api.ui.dialog.replace(
      () => {
        const DialogSelect = api.ui.DialogSelect<PullRequestUrl>
        return (
          <DialogSelect
            title={title}
            options={attachments.map((attachment) => ({
              title: formatPullRequestRef(attachment.pullRequest),
              value: attachment.pullRequest,
              description: attachment.pullRequest.url,
            }))}
            onSelect={(option) => finish(option.value)}
          />
        )
      },
      () => {
        if (!finished) resolve(undefined)
      },
    )
  })
}

function showStateFailure(api: TuiPluginApi, failure: AttachFailure): void {
  api.ui.toast({ variant: "error", title: "Pull request tracker", message: failure.message })
}

type TuiDependencies = Readonly<{
  store: StateStore
  github: GitHubClient
  runner?: ProcessRunner
}>

function toneColor(theme: TuiPluginApi["theme"]["current"], tone: ReturnType<typeof statusAppearance>["tone"]) {
  const colors = {
    green: theme.success,
    yellow: theme.warning,
    red: theme.error,
    purple: theme.secondary,
    gray: theme.textMuted,
  } satisfies Record<ReturnType<typeof statusAppearance>["tone"], typeof theme.success>

  return colors[tone]
}

function PullRequestSidebar(
  props: Readonly<{
    api: TuiPluginApi
    sessionID: string
    dependencies: TuiDependencies
    refreshBus: RefreshBus
  }>,
) {
  const [items, setItems] = createSignal<readonly SidebarPullRequest[]>([])
  const [failure, setFailure] = createSignal<string>()
  const polling = startSessionPolling({
    sessionID: props.sessionID,
    store: props.dependencies.store,
    github: props.dependencies.github,
    publish: (value) => {
      setFailure(undefined)
      setItems(value)
    },
    onStateFailure: (error) => setFailure(error.message),
    onError: () => setFailure("Unable to refresh pull request status"),
  })
  polling.start().catch(() => setFailure("Unable to refresh pull request status"))
  const unsubscribe = props.refreshBus.subscribe(props.sessionID, () => {
    polling.refresh().catch(() => setFailure("Unable to refresh pull request status"))
  })
  const onAbort = () => polling.stop()
  props.api.lifecycle.signal.addEventListener("abort", onAbort, { once: true })
  onCleanup(() => {
    unsubscribe()
    polling.stop()
    props.api.lifecycle.signal.removeEventListener("abort", onAbort)
  })

  return (
    <box flexDirection="column" gap={1}>
      <text fg={props.api.theme.current.text}>
        <b>Pull requests</b>
      </text>
      {failure() ? <text fg={props.api.theme.current.error}>{failure()}</text> : null}
      {!failure() && items().length === 0 ? (
        <text fg={props.api.theme.current.textMuted}>No pull requests attached</text>
      ) : null}
      {items().map((item) => {
        const appearance = statusAppearance(item.status)
        const attributes = appearance.strikethrough ? TextAttributes.STRIKETHROUGH : TextAttributes.NONE
        const title = item.status.tag === "Available" ? item.status.title : "Title unavailable"
        return (
          <box
            flexDirection="column"
            onMouseUp={() => {
              openPullRequest(item.attachment.pullRequest, {
                ...(props.dependencies.runner ? { runner: props.dependencies.runner } : {}),
                signal: props.api.lifecycle.signal,
              })
                .then((result) => {
                  if (!result.ok) {
                    props.api.ui.toast({
                      variant: "error",
                      title: "Pull request tracker",
                      message: result.error.message,
                    })
                  }
                })
                .catch(() => {
                  props.api.ui.toast({
                    variant: "error",
                    title: "Pull request tracker",
                    message: "Unable to open the pull request",
                  })
                })
            }}
          >
            <text fg={toneColor(props.api.theme.current, appearance.tone)} attributes={attributes}>
              <b>{formatPullRequestRef(item.attachment.pullRequest)}</b> {appearance.label}
            </text>
            <text fg={props.api.theme.current.textMuted} attributes={attributes}>
              {title}
            </text>
          </box>
        )
      })}
    </box>
  )
}

export function registerTui(api: TuiPluginApi, dependencies: TuiDependencies): void {
  const refreshBus = createRefreshBus()
  api.event.on("session.updated", (event) => refreshBus.emit(event.properties.sessionID))
  api.event.on("message.updated", (event) => refreshBus.emit(event.properties.sessionID))
  api.event.on("message.part.updated", (event) => refreshBus.emit(event.properties.sessionID))
  const disposeCommands = api.keymap.registerLayer({
    commands: [
      {
        name: "pr.attach",
        title: "Attach pull request",
        category: "Plugin",
        namespace: "palette",
        slashName: "pr-attach",
        async run() {
          const sessionID = currentSessionID(api)
          if (sessionID === undefined) {
            api.ui.toast({ variant: "warning", title: "Pull request tracker", message: "Open a session first" })
            return
          }
          const pullRequest = await promptForPullRequest(api, {
            directory: api.state.path.directory,
            ...(dependencies.runner ? { runner: dependencies.runner } : {}),
            signal: api.lifecycle.signal,
          })
          if (pullRequest === undefined) return

          const result = await dependencies.store.attach(sessionID, pullRequest)
          if (!result.ok) {
            showStateFailure(api, result.error)
            return
          }
          const message =
            result.value === "added"
              ? `Attached ${formatPullRequestRef(pullRequest)}`
              : `${formatPullRequestRef(pullRequest)} is already attached`
          api.ui.toast({
            variant: "success",
            title: "Pull request tracker",
            message,
          })
          refreshBus.emit(sessionID)
        },
      },
      {
        name: "pr.open",
        title: "Open pull request",
        category: "Plugin",
        namespace: "palette",
        slashName: "pr-open",
        async run() {
          const sessionID = currentSessionID(api)
          if (sessionID === undefined) {
            api.ui.toast({ variant: "warning", title: "Pull request tracker", message: "Open a session first" })
            return
          }
          const attachments = await dependencies.store.list(sessionID)
          if (!attachments.ok) {
            showStateFailure(api, attachments.error)
            return
          }
          if (attachments.value.length === 0) {
            api.ui.toast({ variant: "info", title: "Pull request tracker", message: "No pull requests are attached" })
            return
          }

          const pullRequest = await selectPullRequest(api, "Open pull request", attachments.value)
          if (pullRequest === undefined) return
          const result = await openPullRequest(pullRequest, {
            ...(dependencies.runner ? { runner: dependencies.runner } : {}),
            signal: api.lifecycle.signal,
          })
          if (!result.ok) {
            api.ui.toast({ variant: "error", title: "Pull request tracker", message: result.error.message })
          }
        },
      },
      {
        name: "pr.detach",
        title: "Detach pull request",
        category: "Plugin",
        namespace: "palette",
        slashName: "pr-detach",
        async run() {
          const sessionID = currentSessionID(api)
          if (sessionID === undefined) {
            api.ui.toast({ variant: "warning", title: "Pull request tracker", message: "Open a session first" })
            return
          }
          const attachments = await dependencies.store.list(sessionID)
          if (!attachments.ok) {
            showStateFailure(api, attachments.error)
            return
          }
          if (attachments.value.length === 0) {
            api.ui.toast({ variant: "info", title: "Pull request tracker", message: "No pull requests are attached" })
            return
          }

          const pullRequest = await selectPullRequest(api, "Detach pull request", attachments.value)
          if (pullRequest === undefined) return
          const result = await dependencies.store.detach(sessionID, pullRequest)
          if (!result.ok) {
            showStateFailure(api, result.error)
            return
          }
          const message =
            result.value === "removed"
              ? `Detached ${formatPullRequestRef(pullRequest)}`
              : `${formatPullRequestRef(pullRequest)} was not attached`
          api.ui.toast({
            variant: "success",
            title: "Pull request tracker",
            message,
          })
          refreshBus.emit(sessionID)
        },
      },
    ],
    bindings: [],
  })
  api.lifecycle.onDispose(disposeCommands)

  api.slots.register({
    order: 250,
    slots: {
      sidebar_content(_context, value) {
        return (
          <PullRequestSidebar
            api={api}
            sessionID={value.session_id}
            dependencies={dependencies}
            refreshBus={refreshBus}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-pr-tracker",
  async tui(api, options) {
    if (options?.enabled === false) return
    registerTui(api, {
      store: createStateStore(),
      github: createGitHubClient(),
    })
  },
}

export default plugin
