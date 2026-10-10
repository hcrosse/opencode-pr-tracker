import { Config, Option, Redacted } from "effect"

export const smokeConfig = Config.unwrap({
  binary: Config.option(Config.string("OPENCODE_BIN")).pipe(
    Config.map(Option.filter((value) => value.trim() !== "")),
  ),
  githubToken: Config.option(Config.redacted("GH_TOKEN")).pipe(
    Config.map(Option.filter((token) => Redacted.value(token).trim() !== "")),
  ),
  path: Config.string("PATH"),
})
