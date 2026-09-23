import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
  Array as Arr,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
  Stream,
} from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

import packageManifest from "../package.json" with { type: "json" }
import { exerciseRpc } from "./smoke-rpc.ts"

const pluginID = "opencode-pr-tracker"

const PluginEntry = Schema.Struct({
  // A plugin that fails while importing has no ID yet; its source path identifies it.
  id: Schema.optional(Schema.String),
  source: Schema.Struct({ path: Schema.optional(Schema.String) }),
  state: Schema.Struct({ error: Schema.optional(Schema.String), status: Schema.String }),
})

const PluginList = Schema.Struct({ data: Schema.Array(PluginEntry) })

const ServerAddress = Schema.Struct({ password: Schema.String, url: Schema.String })

type ServerAddress = typeof ServerAddress.Type

const addressPattern = /server listening on (?<url>\S+)\s+server password (?<password>\S+)/u

const run = Effect.fn("run")(function* (command: string, args: readonly string[], cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const options = { cwd, stderr: "inherit", stdout: "inherit" } as const

  return yield* spawner
    .exitCode(ChildProcess.make(command, args, options))
    .pipe(
      Effect.flatMap((code) =>
        code === 0 ? Effect.void : Effect.die(`${command} ${args.join(" ")} exited with ${code}`),
      ),
    )
})

const opencodeBinary = Effect.fn("opencodeBinary")(function* () {
  const override = process.env["OPENCODE_BIN"] ?? ""

  if (override !== "") return override

  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const cli = path.dirname(Bun.resolveSync("@opencode/cli/package.json", import.meta.dir))
  const platform = process.platform === "win32" ? "windows" : process.platform
  const base = `@opencode/cli-${platform}-${process.arch}`

  for (const suffix of ["", "-baseline", "-musl", "-baseline-musl"]) {
    const manifest = yield* Effect.option(
      Effect.try(() => Bun.resolveSync(`${base}${suffix}/package.json`, cli)),
    )

    const binary = Option.map(manifest, (found) =>
      path.join(path.dirname(found), "bin", "opencode"),
    )

    if (Option.isSome(binary) && (yield* fs.exists(binary.value))) return binary.value
  }

  return yield* Effect.die(`No OpenCode binary for ${base}`)
})

const preparePackage = Effect.fn("preparePackage")(function* (root: string, runDirectory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const project = path.join(runDirectory, "project")

  yield* run("npm", ["pack", "--ignore-scripts", "--pack-destination", runDirectory], root)

  const tarball = Arr.findFirst(yield* fs.readDirectory(runDirectory), (name) =>
    name.endsWith(".tgz"),
  )

  const plugin = {
    options: { layout: "compact" },
    // A package spec, so OpenCode installs the tarball and its dependencies itself.
    package: `file:${path.join(
      runDirectory,
      Option.getOrElse(tarball, () => ""),
    )}`,
  }

  const config = { plugins: [plugin] }

  yield* fs.makeDirectory(path.join(project, ".opencode"), { recursive: true })
  yield* fs.writeFileString(
    path.join(project, ".opencode", "opencode.json"),
    JSON.stringify(config),
  )

  return project
})

function parseAddress(output: string): Option.Option<ServerAddress> {
  const match = addressPattern.exec(output)

  return Schema.decodeUnknownOption(ServerAddress)(match === null ? null : match.groups)
}

const token = process.env["GH_TOKEN"] ?? ""

const startServer = Effect.fn("startServer")(function* (binary: string, runDirectory: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const home = `${runDirectory}/home`

  // Isolate OpenCode from the developer's configuration, credentials, and data. The GitHub steps
  // need a token, which is passed on only when one is set.
  const variables: readonly (readonly [string, string])[] = [
    ["HOME", home],
    ["PATH", process.env["PATH"] ?? ""],
    ["XDG_CACHE_HOME", `${home}/.cache`],
    ["XDG_CONFIG_HOME", `${home}/.config`],
    ["XDG_DATA_HOME", `${home}/.local/share`],
    ["XDG_STATE_HOME", `${home}/.local/state`],
    ["GH_TOKEN", token],
  ]

  const env = Object.fromEntries(variables.filter(([, value]) => value !== ""))

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

  return yield* Option.match(address, {
    onNone: () => Effect.die("opencode serve exited before reporting its address"),
    onSome: Effect.succeed,
  })
})

const pluginState = Effect.fn("pluginState")(function* (
  url: string,
  password: string,
  project: string,
) {
  const client = yield* HttpClient.HttpClient

  const request = HttpClientRequest.get(`${url}/api/plugin`).pipe(
    HttpClientRequest.setUrlParam("location[directory]", project),
    HttpClientRequest.basicAuth("opencode", password),
  )

  const response = yield* client.execute(request)

  const { body: list } = yield* HttpClientResponse.schemaJson(Schema.Struct({ body: PluginList }))(
    response,
  )

  const entry = Arr.findFirst(
    list.data,
    (plugin) => plugin.id === pluginID || (plugin.source.path ?? "").endsWith(packageManifest.name),
  )

  return Option.match(entry, {
    onNone: () => "absent",
    onSome: (plugin) => [plugin.state.status, plugin.state.error ?? ""].filter(Boolean).join(": "),
  })
})

const smoke = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.join(import.meta.dir, "..")
  const runDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-pr-tracker-smoke-" })
  const binary = yield* opencodeBinary()
  const project = yield* preparePackage(root, runDirectory)
  const { password, url } = yield* startServer(binary, runDirectory)

  yield* pluginState(url, password, project).pipe(
    Effect.orDie,
    // Retry while the plugin is absent or loading; stop as soon as it has failed.
    Effect.filterOrFail(
      (state) => state === "active",
      (state) => state,
    ),
    Effect.retry({
      schedule: Schedule.spaced(Duration.millis(500)),
      times: 180,
      until: (state) => state.startsWith("failed"),
    }),
    Effect.mapError((state) => new Error(`Plugin ${pluginID} did not become active: ${state}`)),
  )
  yield* Effect.logInfo(`${pluginID} is active`)
  yield* exerciseRpc({ password, project, url }, token !== "")
})

NodeRuntime.runMain(
  smoke.pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
)
