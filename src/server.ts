import { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Schedule, Stream } from "effect"

import { live as githubLive } from "./adapters/github/Client.ts"
import { layer as storageLayer } from "./adapters/Storage.ts"
import { Monitor, layer as monitorLayer } from "./application/Monitor.ts"
import { Tracker, layer as trackerLayer } from "./application/Tracker.ts"
import { PullRequestTracker } from "./rpc.ts"
import { settingsOf } from "./server/Options.ts"
import { toView, type Services, type Settings } from "./server/Requests.ts"
import { handlers, publishView } from "./server/Rpc.ts"
import { registerTools } from "./server/Tools.ts"

const pollInterval = "1 second"

/** Forgets a session everywhere once OpenCode deletes it. Every plugin instance sees the event. */
const forgetDeletedSessions = (ctx: Plugin.Context, services: Services): Effect.Effect<void> =>
  ctx.event.subscribe().pipe(
    Stream.runForEach((event) =>
      event.type === "session.deleted"
        ? Effect.andThen(
            services.tracker.forget(event.data.sessionID),
            services.monitor.forget(event.data.sessionID),
          )
        : Effect.void,
    ),
    Effect.ignore,
  )

export default Plugin.define({
  effect: (ctx) =>
    Effect.gen(function* () {
      // OpenCode's plugin effect has no error channel. OpenCode lists a plugin that dies here as
      // failed, with the defect's message as its error.
      const { layout, reviews } = yield* settingsOf(ctx.options).pipe(Effect.orDie)

      const application = monitorLayer.pipe(
        Layer.provideMerge(trackerLayer),
        Layer.provide([githubLive(ctx.storage, reviews), storageLayer(ctx.storage)]),
      )

      const context = yield* Layer.build(application)

      const services: Services = {
        monitor: Context.get(context, Monitor),
        tracker: Context.get(context, Tracker),
      }

      const settings: Settings = {
        directory: ctx.location.directory,
        layout,
      }

      const registration = yield* ctx.rpc
        .register(PullRequestTracker, handlers(services, settings))
        .pipe(Effect.orDie)

      yield* registerTools(ctx.tool, services, settings)
      yield* Effect.forkScoped(forgetDeletedSessions(ctx, services))
      yield* Effect.forkScoped(Effect.repeat(services.monitor.poll, Schedule.spaced(pollInterval)))
      yield* services.monitor.changes.pipe(
        Stream.runForEach((view) =>
          publishView(
            (data) => registration.events.emit("updated", data),
            toView(view, settings.layout),
          ),
        ),
        Effect.forkScoped,
      )
    }),
  id: "opencode-pr-tracker",
})
