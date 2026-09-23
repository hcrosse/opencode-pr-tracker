import { Effect, Result, Schema } from "effect"

import { parsePullRequestUrl } from "../../domain/PullRequest.ts"
import { GitHubFailure, RepositoryUnavailable } from "../../ports/GitHub.ts"
import { CommandRunner } from "../Command.ts"

const RepositoryView = Schema.fromJsonString(Schema.Struct({ url: Schema.String }))

/** Pull request `number` in the GitHub repository `gh` finds at `directory`. */
export const resolveInRepository = Effect.fn("resolveInRepository")(function* (
  directory: string,
  number: number,
) {
  const runner = yield* CommandRunner
  const unavailable = new RepositoryUnavailable({ directory })

  const output = yield* runner.run("gh", ["repo", "view", "--json", "url"], directory).pipe(
    Effect.catchTags({
      CommandFailed: () => Effect.fail(unavailable),
      CommandMissing: () => Effect.fail(new GitHubFailure({ diagnostic: "GitHubCliMissing" })),
    }),
  )

  const view = yield* Schema.decodeUnknownEffect(RepositoryView)(output).pipe(
    Effect.mapError(() => unavailable),
  )

  return yield* Result.match(parsePullRequestUrl(`${view.url}/pull/${String(number)}`), {
    onFailure: () => Effect.fail(unavailable),
    onSuccess: Effect.succeed,
  })
})
