import { describe, expect, test } from "bun:test"

import { ConfigProvider, Effect, Exit, Fiber, Latch, Layer, Option, Redacted } from "effect"

import { CommandFailed } from "../../../src/adapters/Command.ts"
import { layer as tokenLayer, Token, type TokenApi } from "../../../src/adapters/github/Token.ts"
import {
  FixedOutcome,
  fixedCommands,
  scriptedCommands,
  type CommandsFake,
  type FixedOutcome as FixedOutcomeType,
} from "../../support/commands.ts"

const authToken = "gh auth token"

interface Setup {
  readonly environment?: Readonly<Record<string, string>>
  /** Replaces `environment` when a test needs a provider that fails. */
  readonly config?: ConfigProvider.ConfigProvider
  readonly commands: CommandsFake
}

async function run<A, E>(
  setup: Setup,
  use: (token: TokenApi) => Effect.Effect<A, E>,
): Promise<Exit.Exit<A, unknown>> {
  const layer = tokenLayer.pipe(
    Layer.provide(setup.commands.layer),
    Layer.provide(
      ConfigProvider.layer(setup.config ?? ConfigProvider.fromEnvRecord(setup.environment ?? {})),
    ),
  )

  const result = await Effect.runPromise(Effect.exit(Token.use(use).pipe(Effect.provide(layer))))

  return result
}

const value = (token: TokenApi): Effect.Effect<string, unknown> =>
  Effect.map(token.get, Redacted.value)

const withGh = (outcome: FixedOutcomeType): CommandsFake => fixedCommands({ [authToken]: outcome })

/** `gh auth token` answering its nth run with `answers[n]`; runs past the end find no `gh`. */
const scriptedGh = (answers: readonly Effect.Effect<string, CommandFailed>[]): CommandsFake =>
  scriptedCommands((_command: string, _args: readonly string[], count: number) =>
    Option.fromNullishOr(answers[count - 1]),
  )

interface Gate {
  /** Opens once the held `gh auth token` is running. */
  readonly started: Latch.Latch
  /** Lets the held `gh auth token` print its token. */
  readonly release: Latch.Latch
}

interface HeldGh {
  readonly commands: CommandsFake
  readonly gate: Gate
}

/** A `gh auth token` that prints `first` only after its gate is released, then one that prints `second`. */
function heldGh(): HeldGh {
  const gate = { release: Latch.makeUnsafe(), started: Latch.makeUnsafe() }

  const held = gate.started.open.pipe(Effect.andThen(gate.release.await), Effect.as("first\n"))

  return { commands: scriptedGh([held, Effect.succeed("second\n")]), gate }
}

/** Starts `get` and runs it until it waits, so a later step overlaps it. */
const startGet = (token: TokenApi): Effect.Effect<Fiber.Fiber<string, unknown>> =>
  Effect.forkChild(value(token), { startImmediately: true })

/** Two `get`s on a cold cache, the second starting while the first one's load is held. */
const overlappingGets =
  (gate: Gate) =>
  (token: TokenApi): Effect.Effect<string[], unknown> =>
    Effect.gen(function* () {
      const first = yield* startGet(token)

      yield* gate.started.await

      const second = yield* startGet(token)

      yield* gate.release.open

      return yield* Fiber.joinAll([first, second])
    })

/** A `get` whose load is held while the token is invalidated, then the `get` after it. */
const invalidatedWhileLoading =
  (gate: Gate) =>
  (token: TokenApi): Effect.Effect<readonly string[], unknown> =>
    Effect.gen(function* () {
      const loading = yield* startGet(token)

      yield* gate.started.await
      yield* token.invalidate
      yield* gate.release.open

      const loaded = yield* Fiber.join(loading)
      const next = yield* value(token)

      return [loaded, next]
    })

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
    const result = await run(
      { commands: withGh(FixedOutcome.Output({ stdout: "from-gh\n" })), environment },
      value,
    )

    expect(result).toEqual(Exit.succeed(expected))
  })

  test("asks gh once, then again only after the token is invalidated", async () => {
    const commands = withGh(FixedOutcome.Output({ stdout: "from-gh\n" }))

    const result = await run({ commands }, (token: TokenApi) =>
      Effect.all([value(token), value(token), Effect.andThen(token.invalidate, value(token))]),
    )

    expect(result).toEqual(Exit.succeed(["from-gh", "from-gh", "from-gh"]))
    expect(commands.calls).toEqual([authToken, authToken])
  })
})

describe("Token loading", () => {
  test("asks gh once when two requests miss the cache together", async () => {
    const { commands, gate } = heldGh()

    const result = await run({ commands }, overlappingGets(gate))

    expect(result).toEqual(Exit.succeed(["first", "first"]))
    expect(commands.calls).toEqual([authToken])
  })

  test("asks gh again after a token is invalidated while it loads", async () => {
    const { commands, gate } = heldGh()

    const result = await run({ commands }, invalidatedWhileLoading(gate))

    expect(result).toEqual(Exit.succeed(["first", "second"]))
    expect(commands.calls).toEqual([authToken, authToken])
  })

  test("asks gh again after it fails", async () => {
    const notLoggedIn = new CommandFailed({ command: "gh", exitCode: 1, stderr: "not logged in" })
    const commands = scriptedGh([Effect.fail(notLoggedIn), Effect.succeed("second\n")])

    const result = await run({ commands }, (token: TokenApi) =>
      Effect.all([Effect.isFailure(value(token)), value(token)]),
    )

    expect(result).toEqual(Exit.succeed([true, "second"]))
    expect(commands.calls).toEqual([authToken, authToken])
  })
})

describe("Token source failures", () => {
  test.each([
    ["gh is missing", fixedCommands({}), "GitHubCliMissing"],
    [
      "gh is not logged in",
      withGh(FixedOutcome.Exit({ exitCode: 1, stderr: "not logged in" })),
      "AuthenticationRequired",
    ],
    ["gh prints no token", withGh(FixedOutcome.Output({ stdout: "\n" })), "AuthenticationRequired"],
  ] as const)("reports when %s", async (_name, commands, diagnostic) => {
    const result = await run({ commands }, value)

    expect(Exit.findErrorOption(result)).toMatchObject({ value: { diagnostic } })
  })

  test("stops when the environment cannot be read", async () => {
    const unreadable = ConfigProvider.make(() =>
      Effect.fail(new ConfigProvider.SourceError({ message: "unreadable" })),
    )

    const result = await run(
      { commands: withGh(FixedOutcome.Output({ stdout: "from-gh\n" })), config: unreadable },
      value,
    )

    expect(Exit.hasDies(result)).toBe(true)
  })
})
