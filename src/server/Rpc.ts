import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import { Effect } from "effect"

import type { SessionView } from "../application/Monitor.ts"
import { failureMessage } from "../messages.ts"
import { sentChanged, sentView, type PullRequestTracker, type ViewData } from "../rpc.ts"
import { requests, toView, type Services, type Settings } from "./Requests.ts"

/** The RPC methods, over the tracker and monitor of this plugin instance. */
export function handlers(services: Services, settings: Settings): RpcHandlers<PullRequestTracker> {
  const viewOf = (view: SessionView): ViewData => sentView(toView(view, settings.layout))
  const { attach, detach } = requests(services, settings)

  return {
    attach: ({ sessionID, target }, context) =>
      attach(sessionID, target).pipe(
        Effect.map((changed) => sentChanged(changed)),
        Effect.mapError(failureMessage),
        Effect.mapError((message) => context.error("rejected", message, { message })),
      ),
    detach: ({ sessionID, target }, context) =>
      detach(sessionID, target).pipe(
        Effect.map((changed) => sentChanged(changed)),
        Effect.mapError(failureMessage),
        Effect.mapError((message) => context.error("rejected", message, { message })),
      ),
    list: ({ sessionID }, context) =>
      services.monitor.view(sessionID).pipe(
        Effect.map(viewOf),
        Effect.mapError(failureMessage),
        Effect.mapError((message) => context.error("rejected", message, { message })),
      ),
    refresh: ({ sessionID }, context) =>
      services.monitor.refresh(sessionID).pipe(
        Effect.map(viewOf),
        Effect.mapError(failureMessage),
        Effect.mapError((message) => context.error("rejected", message, { message })),
      ),
    watch: ({ sessionID }) => Effect.as(services.monitor.watch(sessionID), {}),
  }
}
