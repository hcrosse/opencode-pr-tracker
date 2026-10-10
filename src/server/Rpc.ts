import type { RpcHandlers } from "@opencode/plugin/effect/rpc"
import { Effect, Match, Option } from "effect"

import type { SessionView } from "../application/Monitor.ts"
import { failureMessage, type RequestFailure } from "../messages.ts"
import {
  sentChanged,
  sentView,
  type PullRequestTracker,
  type Rejected,
  type RejectionReason,
  type ViewData,
} from "../rpc.ts"
import { requests, toView, type Services, type Settings } from "./Requests.ts"

const reasonOf = (failure: RequestFailure): Option.Option<RejectionReason> =>
  Match.valueTags(failure, {
    AmbiguousPullRequestNumber: () => Option.none(),
    AttachmentLimitReached: () => Option.none(),
    GitHubFailure: ({ diagnostic }) => Option.some(diagnostic),
    InvalidPullRequestInput: () => Option.none(),
    PullRequestUnavailable: ({ diagnostic }) => Option.some(diagnostic),
    RepositoryUnavailable: () => Option.none(),
    StackIncomplete: () => Option.none(),
    StoredStateInvalid: () => Option.some<RejectionReason>("StoredStateInvalid"),
  })

/** What a rejected request sends: its message, and its reason when a client can name it. */
export function rejectionOf(failure: RequestFailure): Rejected {
  const message = failureMessage(failure)

  return Option.match(reasonOf(failure), {
    onNone: () => ({ message }),
    onSome: (reason) => ({ message, reason }),
  })
}

/** The RPC methods, over the tracker and monitor of this plugin instance. */
export function handlers(services: Services, settings: Settings): RpcHandlers<PullRequestTracker> {
  const viewOf = (view: SessionView): ViewData => sentView(toView(view, settings.layout))
  const { attach, detach } = requests(services, settings)

  return {
    attach: ({ sessionID, target }, context) =>
      attach(sessionID, target).pipe(
        Effect.map((changed) => sentChanged(changed)),
        Effect.mapError((failure) =>
          context.error("rejected", failureMessage(failure), rejectionOf(failure)),
        ),
      ),
    detach: ({ sessionID, target }, context) =>
      detach(sessionID, target).pipe(
        Effect.map((changed) => sentChanged(changed)),
        Effect.mapError((failure) =>
          context.error("rejected", failureMessage(failure), rejectionOf(failure)),
        ),
      ),
    list: ({ sessionID }, context) =>
      services.monitor.view(sessionID).pipe(
        Effect.map(viewOf),
        Effect.mapError((failure) =>
          context.error("rejected", failureMessage(failure), rejectionOf(failure)),
        ),
      ),
    refresh: ({ sessionID }, context) =>
      services.monitor.refresh(sessionID).pipe(
        Effect.map(viewOf),
        Effect.mapError((failure) =>
          context.error("rejected", failureMessage(failure), rejectionOf(failure)),
        ),
      ),
    watch: ({ sessionID }) => Effect.as(services.monitor.watch(sessionID), {}),
  }
}
