import { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"

import { live as githubLive } from "./adapters/github/Client.ts"
import { layer as storageLayer } from "./adapters/Storage.ts"
import { Monitor, layer as monitorLayer } from "./application/Monitor.ts"
import { Tracker, layer as trackerLayer } from "./application/Tracker.ts"
import { Layout, PullRequestTracker } from "./rpc.ts"
import { toView, type Services, type Settings } from "./server/Requests.ts"
import { handlers } from "./server/Rpc.ts"
import { registerTools } from "./server/Tools.ts"

const pollInterval = "1 second"

const Options = Schema.Struct({ layout: Layout })

/** The sidebar layout from the plugin options; anything but "compact" is the default. */
const layoutOf = (options: Plugin.Context["options"]): Layout =>
  Option.match(Schema.decodeUnknownOption(Options)(options), {
    onNone: () => "default",
    onSome: ({ layout }) => layout,
  })

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
      const application = monitorLayer.pipe(
        Layer.provideMerge(trackerLayer),
        Layer.provide([githubLive, storageLayer(ctx.storage)]),
      )

      const context = yield* Layer.build(application)

      const services: Services = {
        monitor: Context.get(context, Monitor),
        tracker: Context.get(context, Tracker),
      }

      const settings: Settings = {
        directory: ctx.location.directory,
        layout: layoutOf(ctx.options),
      }

      const registration = yield* ctx.rpc
        .register(PullRequestTracker, handlers(services, settings))
        .pipe(Effect.orDie)

      yield* registerTools(ctx.tool, services, settings)
      yield* Effect.forkScoped(forgetDeletedSessions(ctx, services))
      yield* Effect.forkScoped(Effect.repeat(services.monitor.poll, Schedule.spaced(pollInterval)))
      yield* services.monitor.changes.pipe(
        Stream.runForEach((view) =>
          registration.events.emit("updated", toView(view, settings.layout)).pipe(Effect.ignore),
        ),
        Effect.forkScoped,
      )
    }),
  id: "opencode-pr-tracker",
})
