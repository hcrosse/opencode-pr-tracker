/** @jsxImportSource @opentui/solid */
import type { PluginOptions } from "@opencode-ai/plugin"
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

import { createGitHubClient } from "./github.js"
import {
  createPluginUpdateController,
  type PluginReleaseContext,
  type PluginUpdateDependencies,
} from "./plugin-update-tui.js"
import {
  createPullRequestCommands,
  createRefreshBus,
  PullRequestSidebar,
  type PullRequestSidebarLayout,
  type PullRequestTuiDependencies,
  type RefreshBus,
} from "./pull-request-tui.js"
import { createStateStore } from "./state.js"
export { attachPullRequest } from "./pull-request-tui.js"
export { openPullRequest, type OpenPullRequestFailure } from "./external-url.js"
export { updateStatusLabel } from "./plugin-update-tui.js"

export {
  startSessionPolling,
  type PollScheduler,
  type SessionPolling,
  type SessionRefreshResult,
  type SidebarPullRequest,
} from "./polling.js"

type TuiDependencies = PullRequestTuiDependencies &
  PluginUpdateDependencies &
  Readonly<{
    refreshBus?: RefreshBus
  }>

export function parseSidebarLayout(options: PluginOptions | undefined): PullRequestSidebarLayout {
  return options?.layout === "compact" ? "compact" : "default"
}

export function registerTui(
  api: TuiPluginApi,
  dependencies: TuiDependencies,
  release?: PluginReleaseContext,
  layout: PullRequestSidebarLayout = "default",
): void {
  const refreshBus = dependencies.refreshBus ?? createRefreshBus()
  const updates = createPluginUpdateController(api, dependencies, release)
  const disposeEvents = [
    api.event.on("session.updated", (event) => refreshBus.emit(event.properties.sessionID)),
    api.event.on("message.updated", (event) => refreshBus.emit(event.properties.sessionID)),
    api.event.on("message.part.updated", (event) => refreshBus.emit(event.properties.sessionID)),
  ]
  const disposeCommands = api.keymap.registerLayer({
    commands: [...createPullRequestCommands(api, dependencies, refreshBus), updates.command],
    bindings: [],
  })
  api.lifecycle.onDispose(async () => {
    disposeCommands()
    for (const disposeEvent of disposeEvents) disposeEvent()
    await updates.startup
  })

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
            updates={updates}
            layout={layout}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-pr-tracker",
  async tui(api, options, meta) {
    if (options?.enabled === false) return
    registerTui(
      api,
      {
        store: createStateStore(),
        github: createGitHubClient(),
      },
      meta,
      parseSidebarLayout(options),
    )
  },
}

export default plugin
