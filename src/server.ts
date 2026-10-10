import { Plugin } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Schema } from "effect"

import { live as githubLive } from "./adapters/github/Client.ts"
import { layer as storageLayer } from "./adapters/Storage.ts"
import { Monitor, layer as monitorLayer } from "./application/Monitor.ts"
import { Tracker, layer as trackerLayer } from "./application/Tracker.ts"
import { PullRequestTracker, View } from "./rpc.ts"
import { forgetDeletedSessions, pollRepeatedly, sendUpdates } from "./server/Background.ts"
import { settingsOf } from "./server/Options.ts"
import { toView, type Services, type Settings } from "./server/Requests.ts"
import { handlers } from "./server/Rpc.ts"
import { registerTools } from "./server/Tools.ts"

const pollInterval = "1 second"

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
      yield* Effect.forkScoped(forgetDeletedSessions(ctx.event.subscribe(), services))
      yield* Effect.forkScoped(pollRepeatedly(services.monitor.poll, pollInterval))
      yield* Effect.forkScoped(
        sendUpdates(
          services.monitor.changes,
          (view) => Schema.encodeEffect(View)(toView(view, settings.layout)),
          (data) => registration.events.emit("updated", data),
        ),
      )
    }),
  id: "opencode-pr-tracker",
})
