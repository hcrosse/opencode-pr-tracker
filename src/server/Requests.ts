/** Requests to change a session's attachments, shared by the RPC methods and the agent tools. */
import { Effect, Option } from "effect"

import type { MonitorApi, SessionView } from "../application/Monitor.ts"
import type { TrackerApi } from "../application/Tracker.ts"
import { parsePullRequestInput, type PullRequestInput } from "../domain/PullRequest.ts"
import { attachedMessage, detachedMessage, type RequestFailure } from "../messages.ts"
import type { Changed, Layout, View } from "../rpc.ts"

export interface Services {
  readonly tracker: TrackerApi
  readonly monitor: MonitorApi
}

export interface Settings {
  readonly layout: Layout
  /** Where this plugin instance runs; bare pull request numbers resolve in its repository. */
  readonly directory: string
}

export function toView(view: SessionView, layout: Layout): View {
  return {
    entries: view.entries.map((entry) => ({
      attachedAt: entry.attachedAt,
      membership: Option.getOrNull(entry.membership),
      ref: entry.ref,
      status: entry.status,
    })),
    layout,
    sessionID: view.sessionID,
  }
}

const parseTarget = (target: string): Effect.Effect<PullRequestInput, RequestFailure> =>
  Effect.fromResult(parsePullRequestInput(target))

export interface Requests {
  /**
   * Attaches `target`, with its Stack, then publishes the session's view. Only Stack members not yet
   * known are fetched; `target` itself was fetched while attaching.
   */
  readonly attach: (sessionID: string, target: string) => Effect.Effect<Changed, RequestFailure>
  /** Detaches `target`, then publishes the session's view, fetching only statuses not yet known. */
  readonly detach: (sessionID: string, target: string) => Effect.Effect<Changed, RequestFailure>
}

export function requests({ monitor, tracker }: Services, settings: Settings): Requests {
  return {
    attach: (sessionID, target) =>
      Effect.gen(function* () {
        const attached = yield* tracker.attach(
          sessionID,
          yield* parseTarget(target),
          settings.directory,
        )

        const view = yield* monitor.attached(sessionID, attached.ref, attached.report)

        return { message: attachedMessage(attached), view: toView(view, settings.layout) }
      }),
    detach: (sessionID, target) =>
      Effect.gen(function* () {
        const removal = yield* tracker.detach(sessionID, yield* parseTarget(target))
        const view = yield* monitor.show(sessionID)

        return { message: detachedMessage(removal, target), view: toView(view, settings.layout) }
      }),
  }
}
