/** @jsxImportSource @opentui/solid */
import { TextAttributes } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup } from "solid-js"

import {
  attachPullRequest as attachValidatedPullRequest,
  resolvePullRequestInput,
  type AttachPullRequestFailure,
} from "./attach.js"
import { openPullRequest } from "./external-url.js"
import { createGitHubClient, statusAppearance, type GitHubClient, type ProcessRunner } from "./github.js"
import { updateStatusLabel } from "./plugin-update-tui.js"
import { startSessionPolling, type SessionRefreshResult, type SidebarPullRequest } from "./polling.js"
import type { PullRequestAttachment, StateStore } from "./state.js"
import {
  formatPullRequestRef,
  parsePullRequestUrl,
  type InvalidPullRequestUrl,
  type PullRequestUrl,
  type Result,
} from "./url.js"

export type PullRequestTuiDependencies = Readonly<{
  store: StateStore
  github: GitHubClient
  runner?: ProcessRunner
}>

type RefreshListener = Readonly<{
  refresh(): void
  forceRefresh(): Promise<SessionRefreshResult>
}>

export type RefreshBus = Readonly<{
  emit(sessionID: string): void
  forceRefresh(sessionID: string): Promise<SessionRefreshResult | undefined>
  subscribe(sessionID: string, listener: RefreshListener): () => void
}>

export type PluginUpdateState = Readonly<{
  current(): string | undefined
  subscribe(listener: (version: string | undefined) => void): () => void
}>

export type PullRequestCommand = Readonly<{
  name: "pr.attach" | "pr.open" | "pr.detach" | "pr.sync"
  title: string
  category: "Plugin"
  namespace: "palette"
  slashName: "pr-attach" | "pr-open" | "pr-detach" | "pr-sync"
  run(): Promise<void>
}>

export function attachPullRequest(
  store: StateStore,
  sessionID: string,
  input: string,
  options: Readonly<{ github?: GitHubClient; signal?: AbortSignal }> = {},
): Promise<Result<"added" | "already_attached", InvalidPullRequestUrl | AttachPullRequestFailure>> {
  const pullRequest = parsePullRequestUrl(input)
  if (!pullRequest.ok) return Promise.resolve(pullRequest)
  return attachValidatedPullRequest(
    { store, github: options.github ?? createGitHubClient() },
    sessionID,
    pullRequest.value,
    options.signal ? { signal: options.signal } : {},
  )
}

export function createRefreshBus(): RefreshBus {
  const listeners = new Map<string, Set<RefreshListener>>()
  return {
    emit(sessionID) {
      for (const listener of listeners.get(sessionID) ?? []) listener.refresh()
    },
    async forceRefresh(sessionID) {
      const sessionListeners = listeners.get(sessionID)
      if (sessionListeners === undefined || sessionListeners.size === 0) return undefined
      const settled = await Promise.allSettled([...sessionListeners].map((listener) => listener.forceRefresh()))
      const rejected = settled.find((result) => result.status === "rejected")
      if (rejected !== undefined) throw rejected.reason
      const results = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      return (
        results.find((result) => !result.ok) ??
        results.find((result) => result.ok && result.value === "refreshed") ??
        results[0]
      )
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
    const onAbort = () => finish(undefined)
    const finish = (value: PullRequestUrl | undefined, clearDialog = true) => {
      if (finished) return
      finished = true
      options.signal.removeEventListener("abort", onAbort)
      controller.abort()
      if (clearDialog) api.ui.dialog.clear()
      resolve(value)
    }

    if (options.signal.aborted) {
      finish(undefined, false)
      return
    }
    options.signal.addEventListener("abort", onAbort, { once: true })

    api.ui.dialog.setSize("medium")
    api.ui.dialog.replace(
      () => {
        const [error, setError] = createSignal<string>()
        const [busy, setBusy] = createSignal(false)
        const DialogPrompt = api.ui.DialogPrompt
        return (
          <DialogPrompt
            title="Attach pull request"
            placeholder="https://github.com/owner/repository/pull/123, github.com/owner/repository/pull/123, or 123"
            description={() => (error() ? <text fg={api.theme.current.error}>{error()}</text> : null)}
            busy={busy()}
            busyText="Resolving repository"
            onConfirm={(value) => {
              if (finished || busy()) return
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
      () => finish(undefined, false),
    )
  })
}

function selectPullRequest(
  api: TuiPluginApi,
  title: "Open pull request" | "Detach pull request",
  attachments: readonly PullRequestAttachment[],
  showDescriptions: boolean,
  signal: AbortSignal,
): Promise<PullRequestUrl | undefined> {
  return new Promise((resolve) => {
    let finished = false
    const onAbort = () => finish(undefined)
    const finish = (value: PullRequestUrl | undefined, clearDialog = true) => {
      if (finished) return
      finished = true
      signal.removeEventListener("abort", onAbort)
      if (clearDialog) api.ui.dialog.clear()
      resolve(value)
    }

    if (signal.aborted) {
      finish(undefined, false)
      return
    }
    signal.addEventListener("abort", onAbort, { once: true })

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
              ...(showDescriptions ? { description: attachment.pullRequest.url } : {}),
            }))}
            onSelect={(option) => finish(option.value)}
          />
        )
      },
      () => finish(undefined, false),
    )
  })
}

function showStateFailure(api: TuiPluginApi, failure: AttachPullRequestFailure): void {
  api.ui.toast({ variant: "error", title: "Pull request tracker", message: failure.message })
}

export function createPullRequestCommands(
  api: TuiPluginApi,
  dependencies: PullRequestTuiDependencies,
  refreshBus: RefreshBus,
): readonly PullRequestCommand[] {
  return [
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

        const result = await attachValidatedPullRequest(dependencies, sessionID, pullRequest, {
          signal: api.lifecycle.signal,
        })
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

        const pullRequest = await selectPullRequest(
          api,
          "Open pull request",
          attachments.value,
          true,
          api.lifecycle.signal,
        )
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

        const pullRequest = await selectPullRequest(
          api,
          "Detach pull request",
          attachments.value,
          false,
          api.lifecycle.signal,
        )
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
    {
      name: "pr.sync",
      title: "Sync pull request status",
      category: "Plugin",
      namespace: "palette",
      slashName: "pr-sync",
      async run() {
        const sessionID = currentSessionID(api)
        if (sessionID === undefined) {
          api.ui.toast({ variant: "warning", title: "Pull request tracker", message: "Open a session first" })
          return
        }
        try {
          const result = await refreshBus.forceRefresh(sessionID)
          if (result === undefined) {
            api.ui.toast({
              variant: "warning",
              title: "Pull request tracker",
              message: "Pull request sidebar is not available",
            })
            return
          }
          if (!result.ok) {
            api.ui.toast({ variant: "error", title: "Pull request tracker", message: result.error.message })
            return
          }
          switch (result.value) {
            case "refreshed":
              api.ui.toast({
                variant: "success",
                title: "Pull request tracker",
                message: "Pull request status synced",
              })
              return
            case "no_attachments":
              api.ui.toast({
                variant: "info",
                title: "Pull request tracker",
                message: "No pull requests are attached",
              })
              return
            case "stopped":
              api.ui.toast({
                variant: "error",
                title: "Pull request tracker",
                message: "Unable to refresh pull request status",
              })
              return
          }
        } catch {
          api.ui.toast({
            variant: "error",
            title: "Pull request tracker",
            message: "Unable to refresh pull request status",
          })
        }
      },
    },
  ]
}

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

export function PullRequestSidebar(
  props: Readonly<{
    api: TuiPluginApi
    sessionID: string
    dependencies: PullRequestTuiDependencies
    refreshBus: RefreshBus
    updates: PluginUpdateState
  }>,
): JSX.Element {
  const [items, setItems] = createSignal<readonly SidebarPullRequest[]>([])
  const [failure, setFailure] = createSignal<string>()
  const [update, setUpdate] = createSignal<string | undefined>(props.updates.current())
  const [open, setOpen] = createSignal(true)
  const collapsible = () => items().length > 2
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
  const unsubscribe = props.refreshBus.subscribe(props.sessionID, {
    refresh() {
      polling.refresh().catch(() => setFailure("Unable to refresh pull request status"))
    },
    async forceRefresh() {
      try {
        return await polling.forceRefresh()
      } catch (error) {
        setFailure("Unable to refresh pull request status")
        throw error
      }
    },
  })
  const unsubscribeUpdate = props.updates.subscribe(setUpdate)
  const onAbort = () => polling.stop()
  props.api.lifecycle.signal.addEventListener("abort", onAbort, { once: true })
  onCleanup(() => {
    unsubscribe()
    unsubscribeUpdate()
    polling.stop()
    props.api.lifecycle.signal.removeEventListener("abort", onAbort)
  })

  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" gap={1} onMouseDown={() => collapsible() && setOpen((value) => !value)}>
        {collapsible() ? <text fg={props.api.theme.current.text}>{open() ? "▼" : "▶"}</text> : null}
        <text fg={props.api.theme.current.text}>
          <b>Pull requests</b>
        </text>
      </box>
      {!collapsible() || open() ? (
        <box flexDirection="column" gap={1}>
          {update() ? (
            <box flexDirection="row" onMouseUp={() => props.api.keymap.dispatchCommand("pr.tracker.plugin.update")}>
              <text fg={props.api.theme.current.warning}>• </text>
              <text fg={props.api.theme.current.textMuted} attributes={TextAttributes.ITALIC}>
                {updateStatusLabel(update()!)}
              </text>
            </box>
          ) : null}
          {failure() ? <text fg={props.api.theme.current.error}>{failure()}</text> : null}
          {!failure() && items().length === 0 ? (
            <text fg={props.api.theme.current.textMuted}>No pull requests attached</text>
          ) : null}
          {items().length > 0 ? (
            <box flexDirection="column" gap={0}>
              {items().map((item) => {
                const appearance = statusAppearance(item.status)
                const attributes = appearance.strikethrough ? TextAttributes.STRIKETHROUGH : TextAttributes.NONE
                const title = item.status.tag === "Available" ? item.status.title : "Title unavailable"
                return (
                  <box
                    flexDirection="row"
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
                      •{" "}
                    </text>
                    <box flexDirection="column" flexGrow={1}>
                      <text fg={toneColor(props.api.theme.current, appearance.tone)} attributes={attributes}>
                        <b>{formatPullRequestRef(item.attachment.pullRequest)}</b> {appearance.label}
                      </text>
                      <text fg={props.api.theme.current.textMuted} attributes={attributes}>
                        {title}
                      </text>
                    </box>
                  </box>
                )
              })}
            </box>
          ) : null}
        </box>
      ) : null}
    </box>
  )
}
