import { Effect, Option, Schema } from "effect"

import { CommandRunner } from "../adapters/Command.ts"

export class OpenFailed extends Schema.TaggedError<OpenFailed>()("OpenFailed", {
  message: Schema.String,
}) {}

const openers: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  darwin: "open",
  linux: "xdg-open",
}

/** Opens `url` in the default browser. */
export function openUrl(
  url: string,
  platform: NodeJS.Platform,
): Effect.Effect<void, OpenFailed, CommandRunner> {
  return Option.match(Option.fromNullishOr(openers[platform]), {
    onNone: () =>
      Effect.fail(
        new OpenFailed({ message: `Opening pull requests is not supported on ${platform}.` }),
      ),
    onSome: (opener) =>
      CommandRunner.use((runner) => runner.run(opener, [url], ".")).pipe(
        Effect.asVoid,
        Effect.mapError(
          () => new OpenFailed({ message: `Could not open ${url} with \`${opener}\`.` }),
        ),
      ),
  })
}
