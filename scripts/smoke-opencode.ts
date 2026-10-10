import { NodeRuntime, NodeServices } from "@effect/platform-node"
import {
  Array as Arr,
  Config,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

import packageManifest from "../package.json" with { type: "json" }
import { startServer, type ServerAddress } from "./smoke-opencode-server.ts"
import { exerciseRpc } from "./smoke-rpc.ts"

const pluginID = "opencode-pr-tracker"

const PluginEntry = Schema.Struct({
  // A plugin that fails while importing has no ID yet; its source path identifies it.
  id: Schema.optional(Schema.String),
  source: Schema.Struct({ path: Schema.optional(Schema.String) }),
  state: Schema.Struct({ error: Schema.optional(Schema.String), status: Schema.String }),
})

const PluginList = Schema.Struct({ data: Schema.Array(PluginEntry) })

const run = Effect.fn("SmokeOpenCode.run")(function* (
  command: string,
  args: readonly string[],
  cwd: string,
) {
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

const opencodeBinary = Effect.fn("SmokeOpenCode.opencodeBinary")(function* (
  override: Option.Option<string>,
) {
  if (Option.isSome(override)) return override.value

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

const preparePackage = Effect.fn("SmokeOpenCode.preparePackage")(function* (
  root: string,
  runDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const project = path.join(runDirectory, "project")

  yield* run("npm", ["pack", "--ignore-scripts", "--pack-destination", runDirectory], root)

  const tarball = Arr.findFirst(yield* fs.readDirectory(runDirectory), (name) =>
    name.endsWith(".tgz"),
  )

  if (Option.isNone(tarball)) {
    return yield* Effect.die(`npm pack produced no tarball in ${runDirectory}`)
  }

  const plugin = {
    options: { layout: "full" },
    // A package spec, so OpenCode installs the tarball and its dependencies itself.
    package: `file:${path.join(runDirectory, tarball.value)}`,
  }

  const config = { plugins: [plugin] }

  yield* fs.makeDirectory(path.join(project, ".opencode"), { recursive: true })
  yield* fs.writeFileString(
    path.join(project, ".opencode", "opencode.json"),
    JSON.stringify(config),
  )

  return project
})

const pluginState = Effect.fn("SmokeOpenCode.pluginState")(function* (
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

// A plugin whose install fails or stalls is absent from /api/plugin; only OpenCode's log says why.
const printOpenCodeLogs = Effect.fn("SmokeOpenCode.printOpenCodeLogs")(function* (
  runDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const logDirectory = path.join(runDirectory, "home", ".local", "share", "opencode", "log")
  const names = yield* fs.readDirectory(logDirectory)

  for (const name of names) {
    const contents = yield* fs.readFileString(path.join(logDirectory, name))

    process.stderr.write(`--- OpenCode log ${name} ---\n${contents}\n`)
  }
})

const waitForPlugin = Effect.fn("SmokeOpenCode.waitForPlugin")(function* (
  address: ServerAddress,
  project: string,
  runDirectory: string,
) {
  return yield* pluginState(address.url, address.password, project).pipe(
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
    Effect.tapError(() =>
      printOpenCodeLogs(runDirectory).pipe(
        Effect.ignore({ log: "Warn", message: "Could not read OpenCode logs" }),
      ),
    ),
    Effect.mapError((state) => new Error(`Plugin ${pluginID} did not become active: ${state}`)),
  )
})

const smoke = Effect.gen(function* () {
  const config = yield* Config.unwrap({
    binary: Config.option(Config.string("OPENCODE_BIN")),
    githubToken: Config.option(Config.redacted("GH_TOKEN")),
    path: Config.string("PATH"),
  })

  const hasGitHubToken = Option.isSome(config.githubToken)

  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.join(import.meta.dir, "..")
  const runDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-pr-tracker-smoke-" })
  const binary = yield* opencodeBinary(config.binary)
  const project = yield* preparePackage(root, runDirectory)
  const address = yield* startServer(binary, runDirectory, config)

  yield* waitForPlugin(address, project, runDirectory)
  yield* Effect.logInfo(`${pluginID} is active`)
  yield* exerciseRpc({ password: address.password, project, url: address.url }, hasGitHubToken)
})

NodeRuntime.runMain(
  smoke.pipe(Effect.scoped, Effect.provide([NodeServices.layer, FetchHttpClient.layer])),
)
