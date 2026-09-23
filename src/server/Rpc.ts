import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import { Effect } from "effect"

import type { SessionView } from "../application/Monitor.ts"
import { failureMessage, type RequestFailure } from "../messages.ts"
import type { PullRequestTracker, View } from "../rpc.ts"
import { requests, toView, type Services, type Settings } from "./Requests.ts"

/** The RPC methods, over the tracker and monitor of this plugin instance. */
export function handlers(services: Services, settings: Settings): RpcHandlers<PullRequestTracker> {
  const viewOf = (view: SessionView): View => toView(view, settings.layout)
  const { attach, detach } = requests(services, settings)

  return {
    attach: ({ sessionID, target }, context) =>
      attach(sessionID, target).pipe(
        Effect.mapError((failure: RequestFailure) =>
          context.error("rejected", failureMessage(failure), { message: failureMessage(failure) }),
        ),
      ),
    detach: ({ sessionID, target }, context) =>
      detach(sessionID, target).pipe(
        Effect.mapError((failure: RequestFailure) =>
          context.error("rejected", failureMessage(failure), { message: failureMessage(failure) }),
        ),
      ),
    list: ({ sessionID }, context) =>
      services.monitor.view(sessionID).pipe(
        Effect.map(viewOf),
        Effect.mapError((failure: RequestFailure) =>
          context.error("rejected", failureMessage(failure), { message: failureMessage(failure) }),
        ),
      ),
    refresh: ({ sessionID }, context) =>
      services.monitor.refresh(sessionID).pipe(
        Effect.map(viewOf),
        Effect.mapError((failure: RequestFailure) =>
          context.error("rejected", failureMessage(failure), { message: failureMessage(failure) }),
        ),
      ),
  }
}
