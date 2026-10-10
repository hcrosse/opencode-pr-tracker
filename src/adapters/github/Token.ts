import { Cache, Config, Context, Duration, Effect, Exit, Layer, Option, Redacted } from "effect"

import { GitHubFailure } from "../../ports/GitHub.ts"
import { CommandRunner } from "../Command.ts"

export interface TokenApi {
  /** The GitHub token, from `GH_TOKEN`, `GITHUB_TOKEN`, or `gh auth token`, cached after first use. */
  readonly get: Effect.Effect<Redacted.Redacted, GitHubFailure>
  /** Forgets the cached token, so the next `get` reads it again. */
  readonly invalidate: Effect.Effect<void>
}

export class Token extends Context.Service<Token, TokenApi>()("opencode-pr-tracker/Token") {}

/** `GH_TOKEN`, then `GITHUB_TOKEN`, as `gh` itself reads them. Empty values count as unset. */
const variable = (name: string): Config.Config<Option.Option<Redacted.Redacted>> =>
  Config.option(Config.redacted(name)).pipe(
    Config.map(Option.filter((token) => Redacted.value(token).trim() !== "")),
  )

const environmentToken = Config.all([variable("GH_TOKEN"), variable("GITHUB_TOKEN")]).pipe(
  Config.map(
    ([ghToken, githubToken]: readonly [
      Option.Option<Redacted.Redacted>,
      Option.Option<Redacted.Redacted>,
    ]) => Option.orElse(ghToken, () => githubToken),
  ),
)

const tokenKey = "token"

export const layer = Layer.effect(
  Token,
  Effect.gen(function* () {
    const runner = yield* CommandRunner

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

    // Read once at startup; environment changes need a restart.
    const fromEnvironment = yield* environmentToken.pipe(Effect.orDie)

    const load = Option.match(fromEnvironment, {
      onNone: () => Effect.map(fromGh, Redacted.make),
      onSome: Effect.succeed,
    })

    // Concurrent misses share one load.
    const cache = yield* Cache.makeWith((_key: typeof tokenKey) => load, {
      capacity: 1,
      timeToLive: (exit: Exit.Exit<Redacted.Redacted, GitHubFailure>) =>
        Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
    })

    return Token.of({
      get: Cache.get(cache, tokenKey),
      invalidate: Cache.invalidate(cache, tokenKey),
    })
  }),
)
