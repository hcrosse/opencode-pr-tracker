import { Effect, Option, Redacted, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export interface ServerConfiguration {
  readonly githubToken: Option.Option<Redacted.Redacted>
  readonly path: string
}

interface ChildEnvironment {
  readonly env: Readonly<Record<string, string>>
}

const ServerAddress = Schema.Struct({ password: Schema.String, url: Schema.String })

export interface ServerAddress extends Schema.Schema.Type<typeof ServerAddress> {}

const addressPattern = /server listening on (?<url>\S+)\s+server password (?<password>\S+)/u

function parseAddress(output: string): Option.Option<ServerAddress> {
  const match = addressPattern.exec(output)

  return Schema.decodeUnknownOption(ServerAddress)(match === null ? null : match.groups)
}

const makeChildEnvironment = (
  home: string,
  configuration: ServerConfiguration,
): ChildEnvironment => {
  // Isolate OpenCode from the developer's configuration, credentials, and data.
  const variables: readonly (readonly [string, string])[] = [
    ["HOME", home],
    ["PATH", configuration.path],
    ["XDG_CACHE_HOME", `${home}/.cache`],
    ["XDG_CONFIG_HOME", `${home}/.config`],
    ["XDG_DATA_HOME", `${home}/.local/share`],
    ["XDG_STATE_HOME", `${home}/.local/state`],
  ]

  const tokenVariable: readonly (readonly [string, string])[] = Option.match(
    configuration.githubToken,
    {
      onNone: () => [],
      onSome: (redacted) => [["GH_TOKEN", Redacted.value(redacted)] as const],
    },
  )

  return { env: Object.fromEntries([...variables, ...tokenVariable]) }
}

export const startServer = Effect.fn("SmokeOpenCode.startServer")(function* (
  binary: string,
  runDirectory: string,
  configuration: ServerConfiguration,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const home = `${runDirectory}/home`
  const { env } = makeChildEnvironment(home, configuration)
  const args = ["serve", "--hostname", "127.0.0.1", "--port", "0"]

  const handle = yield* spawner.spawn(
    ChildProcess.make(binary, args, { cwd: runDirectory, env, stderr: "inherit" }),
  )

  const address = yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.scan("", (output, chunk) => output + chunk),
    Stream.map(parseAddress),
    Stream.filter(Option.isSome),
    Stream.runHead,
    Effect.map(Option.flatten),
  )

  const serverAddress = yield* Option.match(address, {
    onNone: () => Effect.die("opencode serve exited before reporting its address"),
    onSome: Effect.succeed,
  })

  return serverAddress
})
