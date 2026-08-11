import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { Readable } from "node:stream"

import { runCommand as run } from "./run-command.js"

async function readStream(stream: Readable): Promise<string> {
  stream.setEncoding("utf8")
  let output = ""
  for await (const chunk of stream) {
    if (typeof chunk !== "string") throw new Error("Process emitted non-text output")
    output += chunk
  }
  return output
}

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close()
        reject(new Error("Unable to allocate a local port"))
        return
      }
      server.close((error) => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
  })
}

async function waitForServer(url: string, child: ReturnType<typeof spawn>): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`OpenCode server exited with code ${child.exitCode ?? child.signalCode}`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {
      // The server may refuse connections while it initializes the plugin.
    }
    await Bun.sleep(250)
  }
  throw new Error("OpenCode server did not become healthy within 30 seconds")
}

async function stopServer(child: ReturnType<typeof spawn>, exited: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await exited
    return
  }
  child.kill("SIGTERM")
  const stopped = await Promise.race([exited.then(() => true), Bun.sleep(5_000).then(() => false)])
  if (stopped) return
  child.kill("SIGKILL")
  await exited
}

function assertTools(value: unknown): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("OpenCode returned an invalid tool ID response")
  }
  for (const tool of ["pr_attach", "pr_detach"]) {
    if (!value.includes(tool)) throw new Error(`OpenCode did not register ${tool}`)
  }
}

function assertPluginConfig(value: unknown, expectedPlugin: string): void {
  if (value === null || typeof value !== "object" || !("plugin" in value)) {
    throw new Error("OpenCode generated an invalid TUI config")
  }
  const plugins = value.plugin
  if (!Array.isArray(plugins) || !plugins.includes(expectedPlugin)) {
    throw new Error("OpenCode did not install the TUI plugin")
  }
}

function packageVersion(value: unknown): string {
  if (value === null || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") {
    throw new Error("Installed OpenCode package has an invalid manifest")
  }
  return value.version
}

const tuiSmoke = String.raw`
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const moduleUrl = pathToFileURL(join(process.env.PLUGIN_ROOT, "dist/tui.js")).href
const plugin = (await import(moduleUrl)).default
const layers = []
const disposers = []
let slots

await plugin.tui(
  {
    keymap: {
      registerLayer(layer) {
        layers.push(layer)
        return () => undefined
      },
    },
    slots: {
      register(value) {
        slots = value.slots
        return "opencode-pr-tracker-smoke"
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(disposer) {
        disposers.push(disposer)
        return () => undefined
      },
    },
    event: {
      on() {
        return () => undefined
      },
    },
  },
  undefined,
  { source: "file" },
)

const commands = new Map(
  layers.flatMap((layer) => layer.commands ?? []).map(({ name, slashName }) => [name, slashName]),
)
const expected = [
  { name: "pr.attach", slashName: "pr-attach" },
  { name: "pr.open", slashName: "pr-open" },
  { name: "pr.detach", slashName: "pr-detach" },
  { name: "pr.sync", slashName: "pr-sync" },
  { name: "pr.tracker.plugin.update", slashName: "pr-tracker-plugin-update" },
]
for (const command of expected) {
  if (commands.get(command.name) !== command.slashName) {
    throw new Error("Missing TUI command: " + JSON.stringify(command))
  }
}
if (typeof slots?.sidebar_content !== "function" || disposers.length !== 1) {
  throw new Error("TUI plugin initialization was incomplete")
}
`

const repositoryRoot = resolve(import.meta.dir, "..")
const npmInstallTimeoutMs = 120_000
const { SMOKE_OPENCODE_VERSION: opencodeRelease = "1.x", ...processEnvironment } = process.env
const temporaryRoot = await mkdtemp(join(tmpdir(), "opencode-pr-tracker-smoke-"))

try {
  const packageDirectory = join(temporaryRoot, "package")
  const installDirectory = join(temporaryRoot, "install")
  const opencodeDirectory = join(temporaryRoot, "opencode")
  const projectDirectory = join(temporaryRoot, "project")
  const homeDirectory = join(temporaryRoot, "home")
  const configDirectory = join(temporaryRoot, "config")
  const dataDirectory = join(temporaryRoot, "data")
  const cacheDirectory = join(temporaryRoot, "cache")
  await Promise.all(
    [
      packageDirectory,
      installDirectory,
      opencodeDirectory,
      projectDirectory,
      homeDirectory,
      configDirectory,
      dataDirectory,
      cacheDirectory,
    ].map((directory) => mkdir(directory, { recursive: true })),
  )

  await run(process.execPath, ["run", "build"], { cwd: repositoryRoot, label: "build package" })
  const packOutput = await run("npm", ["pack", "--silent", "--pack-destination", packageDirectory], {
    cwd: repositoryRoot,
    label: "pack distribution",
  })
  const packedNames = packOutput.split(/\r?\n/).filter((line) => line.endsWith(".tgz") && basename(line) === line)
  if (packedNames.length !== 1) {
    throw new Error(`npm pack returned unexpected output: ${packOutput}`)
  }
  const packedName = packedNames[0]
  if (packedName === undefined) throw new Error("npm pack did not return a package filename")
  const packedPath = join(packageDirectory, packedName)

  await run("npm", ["install", "--no-audit", "--no-fund", "--prefix", installDirectory, packedPath], {
    label: "install distribution",
    timeoutMs: npmInstallTimeoutMs,
  })
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      opencodeDirectory,
      `opencode-ai@${opencodeRelease}`,
    ],
    { label: `install opencode-ai@${opencodeRelease}`, timeoutMs: npmInstallTimeoutMs },
  )
  await run("node", [join(opencodeDirectory, "node_modules", "opencode-ai", "postinstall.mjs")], {
    label: "prepare OpenCode launcher",
  })

  const opencodeBinary = join(opencodeDirectory, "node_modules", ".bin", "opencode")
  const pluginRoot = join(installDirectory, "node_modules", "@hcrosse", "opencode-pr-tracker")
  const isolatedEnvironment = {
    ...processEnvironment,
    HOME: homeDirectory,
    XDG_CONFIG_HOME: configDirectory,
    XDG_DATA_HOME: dataDirectory,
    XDG_CACHE_HOME: cacheDirectory,
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
  }

  const opencodePackageSource = await readFile(
    join(opencodeDirectory, "node_modules", "opencode-ai", "package.json"),
    "utf8",
  )
  const opencodePackage: unknown = JSON.parse(opencodePackageSource)
  const installedVersion = packageVersion(opencodePackage)
  for (const [label, directory] of [
    ["prepare global OpenCode config", join(configDirectory, "opencode")],
    ["prepare project OpenCode config", join(projectDirectory, ".opencode")],
  ] as const) {
    await run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        directory,
        `@opencode-ai/plugin@${installedVersion}`,
      ],
      { label, timeoutMs: npmInstallTimeoutMs },
    )
  }
  const opencodeCliVersion = await run(opencodeBinary, ["--version"], {
    env: isolatedEnvironment,
    label: "read OpenCode version",
  })
  console.log(`Testing opencode-ai ${installedVersion} (CLI ${opencodeCliVersion})`)
  const pluginUrl = pathToFileURL(pluginRoot).href
  await run(opencodeBinary, ["plugin", pluginUrl], {
    cwd: projectDirectory,
    env: isolatedEnvironment,
    label: "register plugin",
  })
  const tuiConfigSource = await readFile(join(projectDirectory, ".opencode", "tui.json"), "utf8")
  const tuiConfig: unknown = JSON.parse(tuiConfigSource)
  assertPluginConfig(tuiConfig, pluginUrl)

  const port = await availablePort()
  const serverStartedAt = performance.now()
  console.log("[smoke] start OpenCode server")
  const server = spawn(
    opencodeBinary,
    ["--print-logs", "--log-level", "DEBUG", "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: projectDirectory,
      env: isolatedEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const serverExited = new Promise<void>((resolveExit, reject) => {
    server.once("error", reject)
    server.once("exit", () => resolveExit())
  })
  const serverStdout = readStream(server.stdout)
  const serverStderr = readStream(server.stderr)
  let serverFailure: unknown
  try {
    await waitForServer(`http://127.0.0.1:${port}/global/health`, server)
    console.log(`[smoke] OpenCode server ready in ${((performance.now() - serverStartedAt) / 1000).toFixed(1)}s`)
    const toolIdsStartedAt = performance.now()
    console.log("[smoke] load plugin tool IDs")
    const response = await fetch(
      `http://127.0.0.1:${port}/experimental/tool/ids?directory=${encodeURIComponent(projectDirectory)}`,
      { signal: AbortSignal.timeout(60_000) },
    )
    if (!response.ok) throw new Error(`OpenCode tool endpoint returned HTTP ${response.status}`)
    assertTools(await response.json())
    console.log(`[smoke] plugin tool IDs loaded in ${((performance.now() - toolIdsStartedAt) / 1000).toFixed(1)}s`)
  } catch (error) {
    serverFailure = error
  } finally {
    await stopServer(server, serverExited)
  }
  const [stdout, stderr] = await Promise.all([serverStdout, serverStderr])
  if (serverFailure) {
    console.error(stdout)
    console.error(stderr)
    throw serverFailure
  }

  await run(process.execPath, ["-e", tuiSmoke], {
    env: { ...isolatedEnvironment, PLUGIN_ROOT: pluginRoot },
    label: "initialize TUI plugin",
  })
  console.log("OpenCode server and TUI plugin smoke checks passed")
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
