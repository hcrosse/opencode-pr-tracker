/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"

import { casesHandled } from "./exhaustive.js"
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

    await Promise.all(
      attachments.value.map(async (attachment) => {
        const previous = statuses.get(attachment.pullRequest.url)
        if (previous?.tag === "Available" && previous.state.tag !== "Open") return

        const result = await input.github.get(attachment.pullRequest, { signal: controller.signal })
        if (stopped || (!result.ok && result.error.tag === "GitHubCancelled")) return
        if (result.ok) {
          statuses.set(attachment.pullRequest.url, result.value)
          return
        }
        statuses.set(
          attachment.pullRequest.url,
          previous?.tag === "Available" ? { ...previous, stale: true } : { tag: "Unavailable" },
        )
      }),
    )

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
      if (timer === undefined) {
        timer = scheduler.setInterval(() => {
          refresh().catch(input.onError)
        }, pollIntervalMilliseconds)
      }
      return refresh()
    },
    refresh,
    stop() {
      if (stopped) return
      stopped = true
      controller.abort()
      if (timer !== undefined) scheduler.clearInterval(timer)
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

function promptForPullRequest(api: TuiPluginApi): Promise<PullRequestUrl | undefined> {
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
        const [error, setError] = createSignal<string>()
        const DialogPrompt = api.ui.DialogPrompt
        return (
          <DialogPrompt
            title="Attach pull request"
            placeholder="https://github.com/owner/repository/pull/123"
            description={() => (error() ? <text fg={api.theme.current.error}>{error()}</text> : null)}
            onConfirm={(value) => {
              const parsed = parsePullRequestUrl(value)
              if (!parsed.ok) {
                setError(parsed.error.message)
                return
              }
              finish(parsed.value)
            }}
            onCancel={() => finish(undefined)}
          />
        )
      },
      () => {
        if (!finished) resolve(undefined)
      },
    )
  })
}

function selectPullRequest(
  api: TuiPluginApi,
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
            title="Detach pull request"
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

function showStateFailure(api: TuiPluginApi, failure: StateFailure | AttachFailure): void {
  api.ui.toast({ variant: "error", title: "Pull request tracker", message: failure.message })
}

type TuiDependencies = Readonly<{
  store: StateStore
  github: GitHubClient
  runner?: ProcessRunner
}>

function toneColor(theme: TuiPluginApi["theme"]["current"], tone: ReturnType<typeof statusAppearance>["tone"]) {
  if (tone === "green") return theme.success
  if (tone === "yellow") return theme.warning
  if (tone === "red") return theme.error
  if (tone === "purple") return theme.secondary
  return theme.textMuted
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
          const pullRequest = await promptForPullRequest(api)
          if (pullRequest === undefined) return

          const result = await dependencies.store.attach(sessionID, pullRequest)
          if (!result.ok) {
            showStateFailure(api, result.error)
            return
          }
          let message: string
          switch (result.value) {
            case "added":
              message = `Attached ${formatPullRequestRef(pullRequest)}`
              break
            case "already_attached":
              message = `${formatPullRequestRef(pullRequest)} is already attached`
              break
            default:
              casesHandled(result.value)
          }
          api.ui.toast({
            variant: "success",
            title: "Pull request tracker",
            message,
          })
          refreshBus.emit(sessionID)
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

          const pullRequest = await selectPullRequest(api, attachments.value)
          if (pullRequest === undefined) return
          const result = await dependencies.store.detach(sessionID, pullRequest)
          if (!result.ok) {
            showStateFailure(api, result.error)
            return
          }
          let message: string
          switch (result.value) {
            case "removed":
              message = `Detached ${formatPullRequestRef(pullRequest)}`
              break
            case "absent":
              message = `${formatPullRequestRef(pullRequest)} was not attached`
              break
            default:
              casesHandled(result.value)
          }
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
