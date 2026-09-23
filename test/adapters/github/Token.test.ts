import { describe, expect, test } from "bun:test"

import { ConfigProvider, Effect, Exit, Layer, Redacted } from "effect"

import { layer as tokenLayer, Token, type TokenApi } from "../../../src/adapters/github/Token.ts"
import {
  exitWith,
  fixedCommands,
  output,
  type CommandsFake,
  type FixedOutcome,
} from "../../support/github.ts"

const authToken = "gh auth token"

interface Setup {
  readonly environment?: Readonly<Record<string, string>>
  readonly commands: CommandsFake
}

async function run<A, E>(
  setup: Setup,
  use: (token: TokenApi) => Effect.Effect<A, E>,
): Promise<Exit.Exit<A, unknown>> {
  const layer = tokenLayer.pipe(
    Layer.provide(setup.commands.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(setup.environment ?? {}))),
  )

  const result = await Effect.runPromise(Effect.exit(Token.use(use).pipe(Effect.provide(layer))))

  return result
}

const value = (token: TokenApi): Effect.Effect<string, unknown> =>
  Effect.map(token.get, Redacted.value)

const withGh = (outcome: FixedOutcome): CommandsFake => fixedCommands({ [authToken]: outcome })

describe("Token source order", () => {
  test.each([
    [
      "GH_TOKEN before GITHUB_TOKEN and gh",
      { GH_TOKEN: "from-gh-token", GITHUB_TOKEN: "from-github-token" },
      "from-gh-token",
    ],
    ["GITHUB_TOKEN before gh", { GITHUB_TOKEN: "from-github-token" }, "from-github-token"],
    [
      "GITHUB_TOKEN when GH_TOKEN is empty",
      { GH_TOKEN: " ", GITHUB_TOKEN: "from-github-token" },
      "from-github-token",
    ],
    ["gh when the variables are empty", { GH_TOKEN: " ", GITHUB_TOKEN: "" }, "from-gh"],
    ["gh when the variables are unset", {}, "from-gh"],
  ] as const)("prefers %s", async (_name, environment, expected) => {
    const result = await run({ commands: withGh(output("from-gh\n")), environment }, value)

    expect(result).toEqual(Exit.succeed(expected))
  })

  test("asks gh once, then again only after the token is invalidated", async () => {
    const commands = withGh(output("from-gh\n"))

    const result = await run({ commands }, (token: TokenApi) =>
      Effect.all([value(token), value(token), Effect.andThen(token.invalidate, value(token))]),
    )

    expect(result).toEqual(Exit.succeed(["from-gh", "from-gh", "from-gh"]))
    expect(commands.calls).toEqual([authToken, authToken])
  })
})

describe("Token source failures", () => {
  test.each([
    ["gh is missing", fixedCommands({}), "GitHubCliMissing"],
    ["gh is not logged in", withGh(exitWith(1, "not logged in")), "AuthenticationRequired"],
    ["gh prints no token", withGh(output("\n")), "AuthenticationRequired"],
  ] as const)("reports when %s", async (_name, commands, diagnostic) => {
    const result = await run({ commands }, value)

    expect(Exit.findErrorOption(result)).toMatchObject({ value: { diagnostic } })
  })
})
