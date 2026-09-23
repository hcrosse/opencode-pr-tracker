import { Config, Context, Effect, Layer, Option, Redacted, Ref } from "effect"

import { GitHubFailure } from "../../ports/GitHub.ts"
import { CommandRunner } from "./Command.ts"

export interface TokenApi {
  /** The GitHub token, from `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`, cached after first use. */
  readonly get: Effect.Effect<Redacted.Redacted, GitHubFailure>
  /** Forgets the cached token, so the next `get` reads it again. */
  readonly invalidate: Effect.Effect<void>
}

export class Token extends Context.Service<Token, TokenApi>()("opencode-pr-tracker/Token") {}

/** `GH_TOKEN`, then `GITHUB_TOKEN`, as `gh` itself reads them. Empty values count as unset. */
const environmentToken = Config.option(
  Config.orElse(Config.redacted("GH_TOKEN"), () => Config.redacted("GITHUB_TOKEN")),
).pipe(Config.map(Option.filter((token) => Redacted.value(token).trim() !== "")))

export const layer = Layer.effect(
  Token,
  Effect.gen(function* () {
    const runner = yield* CommandRunner
    const cached = yield* Ref.make(Option.none<Redacted.Redacted>())

    const fromGh = runner.run("gh", ["auth", "token"], process.cwd()).pipe(
      Effect.map((output) => output.trim()),
      Effect.filterOrFail(
        (token) => token !== "",
        () => new GitHubFailure({ diagnostic: "AuthenticationRequired" }),
      ),
      Effect.catchTags({
        CommandFailed: () =>
          Effect.fail(new GitHubFailure({ diagnostic: "AuthenticationRequired" })),
        CommandMissing: () => Effect.fail(new GitHubFailure({ diagnostic: "GitHubCliMissing" })),
      }),
    )

    // Read once: the environment does not change while the plugin runs.
    const fromEnvironment = yield* environmentToken.pipe(
      Effect.orElseSucceed(() => Option.none<Redacted.Redacted>()),
    )

    const load = Option.match(fromEnvironment, {
      onNone: () => Effect.map(fromGh, Redacted.make),
      onSome: Effect.succeed,
    }).pipe(Effect.tap((token) => Ref.set(cached, Option.some(token))))

    return Token.of({
      get: Ref.get(cached).pipe(
        Effect.flatMap(Option.match({ onNone: () => load, onSome: Effect.succeed })),
      ),
      invalidate: Ref.set(cached, Option.none()),
    })
  }),
)
