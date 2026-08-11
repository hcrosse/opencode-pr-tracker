import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Result } from "./url.js"

export const updateCacheKey = "plugin-update-check-v1"

const packageName = "@hcrosse/opencode-pr-tracker"
const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`
const updateCacheMilliseconds = 24 * 60 * 60 * 1000

export type AvailablePluginUpdate = Readonly<{
  currentVersion: string
  version: string
}>

export type UpdateCheckFailure =
  | Readonly<{
      tag: "InvalidUpdateResponse"
      message: "The npm registry returned invalid plugin release metadata"
    }>
  | Readonly<{
      tag: "UpdateCheckUnavailable"
      message: "Unable to check for plugin updates"
      cause: unknown
    }>
  | Readonly<{
      tag: "UpdateCheckCancelled"
      message: "Plugin update check cancelled"
    }>

export type UpdateCache = Readonly<{
  checkedAt: number
  currentVersion: string
  opencodeVersion: string
  availableVersion: string | null
}>

export type InstallationScope = "project" | "global"

type UpdateVersions = Readonly<{
  currentVersion: string
  opencodeVersion: string
}>

type RegistryRelease = Readonly<{
  version: string
  opencodeRange: string
}>

export type UpdateFetcher = (url: string, options?: Readonly<{ signal?: AbortSignal }>) => Promise<Response>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseRegistryReleases(input: unknown): readonly RegistryRelease[] | undefined {
  if (!isRecord(input) || !isRecord(input.versions)) return undefined

  const releases: RegistryRelease[] = []
  for (const [version, metadata] of Object.entries(input.versions)) {
    if (!isRecord(metadata) || !isRecord(metadata.engines) || typeof metadata.engines.opencode !== "string") continue
    releases.push({ version, opencodeRange: metadata.engines.opencode })
  }
  return releases
}

function isStableVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(version)
}

function newestCompatibleUpdate(
  releases: readonly RegistryRelease[],
  versions: UpdateVersions,
): AvailablePluginUpdate | undefined {
  let latest: string | undefined
  for (const release of releases) {
    if (!isStableVersion(release.version)) continue
    try {
      if (!Bun.semver.satisfies(versions.opencodeVersion, release.opencodeRange)) continue
      if (Bun.semver.order(release.version, versions.currentVersion) <= 0) continue
      if (latest === undefined || Bun.semver.order(release.version, latest) > 0) latest = release.version
    } catch {
      continue
    }
  }
  return latest === undefined ? undefined : { currentVersion: versions.currentVersion, version: latest }
}

function isCancellation(cause: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (cause instanceof DOMException && cause.name === "AbortError")
}

export async function checkForUpdate(
  versions: UpdateVersions,
  options: Readonly<{
    fetch?: UpdateFetcher
    signal?: AbortSignal
  }> = {},
): Promise<Result<AvailablePluginUpdate | undefined, UpdateCheckFailure>> {
  const fetcher: UpdateFetcher = options.fetch ?? ((url, input) => globalThis.fetch(url, input))
  let response: Response
  try {
    response = await fetcher(registryUrl, options.signal ? { signal: options.signal } : {})
  } catch (cause) {
    if (isCancellation(cause, options.signal)) {
      return { ok: false, error: { tag: "UpdateCheckCancelled", message: "Plugin update check cancelled" } }
    }
    return {
      ok: false,
      error: { tag: "UpdateCheckUnavailable", message: "Unable to check for plugin updates", cause },
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      error: {
        tag: "UpdateCheckUnavailable",
        message: "Unable to check for plugin updates",
        cause: new Error(`npm registry returned HTTP ${response.status}`),
      },
    }
  }

  let decoded: unknown
  try {
    decoded = await response.json()
  } catch {
    return {
      ok: false,
      error: {
        tag: "InvalidUpdateResponse",
        message: "The npm registry returned invalid plugin release metadata",
      },
    }
  }
  const releases = parseRegistryReleases(decoded)
  if (releases === undefined) {
    return {
      ok: false,
      error: {
        tag: "InvalidUpdateResponse",
        message: "The npm registry returned invalid plugin release metadata",
      },
    }
  }
  return { ok: true, value: newestCompatibleUpdate(releases, versions) }
}

export function parseFreshUpdateCache(
  input: unknown,
  versions: UpdateVersions,
  now: number = Date.now(),
): string | null | undefined {
  if (!isRecord(input)) return undefined
  if (
    typeof input.checkedAt !== "number" ||
    !Number.isFinite(input.checkedAt) ||
    input.checkedAt > now ||
    now - input.checkedAt >= updateCacheMilliseconds ||
    input.currentVersion !== versions.currentVersion ||
    input.opencodeVersion !== versions.opencodeVersion ||
    (input.availableVersion !== null && typeof input.availableVersion !== "string")
  ) {
    return undefined
  }
  return input.availableVersion
}

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT"
}

async function readConfig(path: string): Promise<unknown> {
  try {
    return Bun.JSONC.parse(await readFile(path, "utf8"))
  } catch (cause) {
    if (isMissingFile(cause)) return undefined
    return undefined
  }
}

function configuredPluginSpecifier(input: unknown): string | undefined {
  if (typeof input === "string") return input
  if (Array.isArray(input) && input.length === 2 && typeof input[0] === "string" && isRecord(input[1])) {
    return input[0]
  }
  return undefined
}

function containsPlugin(input: unknown): boolean {
  if (!isRecord(input) || !Array.isArray(input.plugin)) return false
  return input.plugin.some((entry) => {
    const spec = configuredPluginSpecifier(entry)
    return (
      spec !== undefined &&
      (spec === packageName || spec.startsWith(`${packageName}/`) || spec.startsWith(`${packageName}@`))
    )
  })
}

async function containsConfiguredPlugin(directory: string): Promise<boolean> {
  const configs = await Promise.all(
    ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"].map((name) => readConfig(join(directory, name))),
  )
  return configs.some(containsPlugin)
}

export async function detectInstallationScopes(
  input: Readonly<{
    projectConfigDirectory: string
    globalConfigDirectory: string
  }>,
): Promise<readonly InstallationScope[]> {
  const [project, global] = await Promise.all([
    containsConfiguredPlugin(input.projectConfigDirectory),
    containsConfiguredPlugin(input.globalConfigDirectory),
  ])
  return [...(project ? (["project"] as const) : []), ...(global ? (["global"] as const) : [])]
}

function updateCommand(version: string, scope: InstallationScope): string {
  const globalFlag = scope === "global" ? " --global" : ""
  return `opencode plugin ${packageName}@${version}${globalFlag} --force`
}

export function formatUpdateInstructions(version: string, scopes: readonly InstallationScope[]): string {
  const commands = scopes.length === 0 ? (["project", "global"] as const) : scopes
  const body =
    commands.length === 1
      ? updateCommand(version, commands[0]!)
      : commands
          .map(
            (scope) => `${scope === "project" ? "Project" : "Global"} installation:\n${updateCommand(version, scope)}`,
          )
          .join("\n\n")
  return `${body}\n\nRestart OpenCode after updating.`
}
