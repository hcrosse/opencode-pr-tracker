/** @jsxImportSource @opentui/solid */
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"
import { join } from "node:path"

import {
  checkForUpdate,
  detectInstallationScopes,
  formatUpdateInstructions,
  parseFreshUpdateCache,
  updateCacheKey,
  type InstallationScope,
  type UpdateCache,
} from "./update.js"

export type PluginReleaseContext = Pick<TuiPluginMeta, "source" | "version">

export type PluginUpdateDependencies = Readonly<{
  updateChecker?: typeof checkForUpdate
  installationScopes?: typeof detectInstallationScopes
  now?: () => number
}>

export type PluginUpdateController = Readonly<{
  command: {
    name: "pr.tracker.plugin.update"
    title: "Update PR tracker plugin"
    category: "Plugin"
    namespace: "palette"
    slashName: "pr-tracker-plugin-update"
    run(): Promise<void>
  }
  current(): string | undefined
  subscribe(listener: (version: string | undefined) => void): () => void
  startup: Promise<void> | undefined
}>

type UpdateBus = Readonly<{
  current(): string | undefined
  publish(version: string | undefined): void
  subscribe(listener: (version: string | undefined) => void): () => void
}>

function createUpdateBus(): UpdateBus {
  const listeners = new Set<(version: string | undefined) => void>()
  let version: string | undefined
  return {
    current: () => version,
    publish(value) {
      version = value
      for (const listener of listeners) listener(value)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function writeUpdateCache(
  api: TuiPluginApi,
  versions: Readonly<{ currentVersion: string; opencodeVersion: string }>,
  availableVersion: string | null,
  now: () => number,
): void {
  const cache: UpdateCache = { checkedAt: now(), ...versions, availableVersion }
  api.kv.set(updateCacheKey, cache)
}

function waitForKvReady(api: TuiPluginApi): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (ready: boolean) => {
      if (timer !== undefined) clearTimeout(timer)
      api.lifecycle.signal.removeEventListener("abort", onAbort)
      resolve(ready)
    }
    const onAbort = () => finish(false)
    const check = () => {
      if (api.lifecycle.signal.aborted) {
        finish(false)
      } else if (api.kv.ready) {
        finish(true)
      } else {
        timer = setTimeout(check, 10)
      }
    }
    api.lifecycle.signal.addEventListener("abort", onAbort, { once: true })
    check()
  })
}

export function updateStatusLabel(version: string): string {
  return `${version} available`
}

export function createPluginUpdateController(
  api: TuiPluginApi,
  dependencies: PluginUpdateDependencies,
  release?: PluginReleaseContext,
): PluginUpdateController {
  const updateBus = createUpdateBus()
  const updateChecker = dependencies.updateChecker ?? checkForUpdate
  const installationScopes = dependencies.installationScopes ?? detectInstallationScopes
  const now = dependencies.now ?? Date.now
  const versions =
    release?.source === "npm" && release.version !== undefined
      ? { currentVersion: release.version, opencodeVersion: api.app.version }
      : undefined
  let updateOperations: Promise<void> = Promise.resolve()
  function serializeUpdateOperation<Value>(operation: () => Promise<Value>): Promise<Value> {
    const result = updateOperations.then(operation)
    updateOperations = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  let startup: Promise<void> | undefined
  if (versions !== undefined) {
    startup = serializeUpdateOperation(async () => {
      try {
        if (!(await waitForKvReady(api))) return
        const cached = parseFreshUpdateCache(api.kv.get(updateCacheKey), versions, now())
        if (cached !== undefined) {
          updateBus.publish(cached ?? undefined)
          return
        }
        const result = await updateChecker(versions, { signal: api.lifecycle.signal })
        if (api.lifecycle.signal.aborted) return
        const availableVersion = result.ok ? (result.value?.version ?? null) : null
        writeUpdateCache(api, versions, availableVersion, now)
        if (result.ok) updateBus.publish(result.value?.version)
      } catch {
        if (!api.lifecycle.signal.aborted && api.kv.ready) writeUpdateCache(api, versions, null, now)
      }
    })
  }

  const command: PluginUpdateController["command"] = {
    name: "pr.tracker.plugin.update",
    title: "Update PR tracker plugin",
    category: "Plugin",
    namespace: "palette",
    slashName: "pr-tracker-plugin-update",
    async run() {
      if (versions === undefined) {
        api.ui.toast({
          variant: "info",
          title: "Pull request tracker",
          message: "Update checks are unavailable for this plugin installation",
        })
        return
      }
      const result = await serializeUpdateOperation(async () => {
        if (!(await waitForKvReady(api))) return undefined
        const checked = await updateChecker(versions, { signal: api.lifecycle.signal })
        if (api.lifecycle.signal.aborted || (!checked.ok && checked.error.tag === "UpdateCheckCancelled")) {
          return undefined
        }
        if (checked.ok) {
          writeUpdateCache(api, versions, checked.value?.version ?? null, now)
          updateBus.publish(checked.value?.version)
        }
        return checked
      })
      if (result === undefined) return
      if (!result.ok) {
        api.ui.toast({ variant: "error", title: "Pull request tracker", message: result.error.message })
        return
      }
      if (result.value === undefined) {
        api.ui.toast({ variant: "info", title: "Pull request tracker", message: "PR tracker is up to date" })
        return
      }
      const update = result.value
      let scopes: readonly InstallationScope[]
      try {
        const projectRoot = api.state.path.worktree === "/" ? api.state.path.directory : api.state.path.worktree
        scopes = await installationScopes({
          projectConfigDirectory: join(projectRoot, ".opencode"),
          globalConfigDirectory: api.state.path.config,
        })
      } catch {
        scopes = []
      }
      if (api.lifecycle.signal.aborted) return
      api.ui.dialog.setSize("medium")
      api.ui.dialog.replace(() => (
        <api.ui.DialogAlert
          title={`Update PR tracker to ${update.version}`}
          message={formatUpdateInstructions(update.version, scopes)}
        />
      ))
    },
  }

  return {
    command,
    current: updateBus.current,
    subscribe: updateBus.subscribe,
    startup,
  }
}
