import { afterEach, describe, expect, test } from "bun:test"
import * as hegel from "@hegeldev/hegel"
import * as generators from "@hegeldev/hegel/generators"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  checkForUpdate,
  detectInstallationScopes,
  formatUpdateInstructions,
  parseFreshUpdateCache,
  type UpdateCache,
} from "../src/update.js"

const now = new Date("2026-08-11T12:00:00.000Z").valueOf()
const dayMilliseconds = 24 * 60 * 60 * 1000
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function registryResponse(versions: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ versions }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("plugin update checks", () => {
  test("selects the highest newer stable release compatible with OpenCode", async () => {
    const signal = new AbortController().signal
    const requests: Array<{ url: string; signal: AbortSignal | null | undefined }> = []

    const result = await checkForUpdate(
      { currentVersion: "0.2.0", opencodeVersion: "1.18.15" },
      {
        signal,
        async fetch(url, init) {
          requests.push({ url, signal: init?.signal })
          return registryResponse({
            "0.2.1": { engines: { opencode: ">=1.18.15 <2" } },
            "0.3.0-beta.1": { engines: { opencode: ">=1.18.15 <2" } },
            "0.3.0": { engines: { opencode: ">=1.19.0 <2" } },
            "0.2.2": { engines: { opencode: ">=1.18.15 <2" } },
            invalid: { engines: { opencode: ">=1.18.15 <2" } },
            "0.2.3": { engines: {} },
          })
        },
      },
    )

    expect(result).toEqual({ ok: true, value: { currentVersion: "0.2.0", version: "0.2.2" } })
    expect(requests).toEqual([
      {
        url: "https://registry.npmjs.org/%40hcrosse%2Fopencode-pr-tracker",
        signal,
      },
    ])
  })

  test("returns no update when compatible releases are not newer", async () => {
    const result = await checkForUpdate(
      { currentVersion: "0.2.1", opencodeVersion: "1.18.15" },
      {
        async fetch() {
          return registryResponse({
            "0.2.0": { engines: { opencode: ">=1.18.15 <2" } },
            "0.2.1": { engines: { opencode: ">=1.18.15 <2" } },
            "0.3.0": { engines: { opencode: ">=2" } },
          })
        },
      },
    )

    expect(result).toEqual({ ok: true, value: undefined })
  })

  test("rejects malformed registry responses", async () => {
    const result = await checkForUpdate(
      { currentVersion: "0.2.0", opencodeVersion: "1.18.15" },
      {
        async fetch() {
          return new Response(JSON.stringify({ versions: [] }))
        },
      },
    )

    expect(result).toEqual({
      ok: false,
      error: {
        tag: "InvalidUpdateResponse",
        message: "The npm registry returned invalid plugin release metadata",
      },
    })
  })

  test("classifies unavailable and cancelled requests", async () => {
    const unavailableCause = new Error("offline")
    const unavailable = await checkForUpdate(
      { currentVersion: "0.2.0", opencodeVersion: "1.18.15" },
      {
        async fetch() {
          throw unavailableCause
        },
      },
    )
    const controller = new AbortController()
    controller.abort()
    const cancelled = await checkForUpdate(
      { currentVersion: "0.2.0", opencodeVersion: "1.18.15" },
      {
        signal: controller.signal,
        async fetch() {
          throw new DOMException("aborted", "AbortError")
        },
      },
    )

    expect(unavailable).toEqual({
      ok: false,
      error: { tag: "UpdateCheckUnavailable", message: "Unable to check for plugin updates", cause: unavailableCause },
    })
    expect(cancelled).toEqual({
      ok: false,
      error: { tag: "UpdateCheckCancelled", message: "Plugin update check cancelled" },
    })
  })
})

describe("plugin update cache", () => {
  const cache: UpdateCache = {
    checkedAt: now - 60_000,
    currentVersion: "0.2.0",
    opencodeVersion: "1.18.15",
    availableVersion: "0.2.1",
  }

  test("reuses cache entries exactly within the freshness window", () =>
    hegel.test((testCase) => {
      const age = testCase.draw(generators.integers({ minValue: -1, maxValue: dayMilliseconds * 2 }))
      const input = { ...cache, checkedAt: now - age }

      const result = parseFreshUpdateCache(input, cache, now)

      expect(result).toBe(age >= 0 && age < dayMilliseconds ? cache.availableVersion : undefined)
    }))

  test("reuses a matching result for twenty-four hours", () => {
    expect(parseFreshUpdateCache(cache, { currentVersion: "0.2.0", opencodeVersion: "1.18.15" }, now)).toBe("0.2.1")
    expect(parseFreshUpdateCache({ ...cache, availableVersion: null }, cache, now)).toBeNull()
  })

  test("rejects expired, version-mismatched, and malformed entries", () => {
    expect(parseFreshUpdateCache({ ...cache, checkedAt: now - 86_400_000 }, cache, now)).toBeUndefined()
    expect(parseFreshUpdateCache(cache, { currentVersion: "0.2.1", opencodeVersion: "1.18.15" }, now)).toBeUndefined()
    for (const availableVersion of [1, "invalid", "0.1.0", "0.3.0-beta.1", "00.2.1", "0.2.1+.", "0.2.1+foo..bar"]) {
      expect(parseFreshUpdateCache({ ...cache, availableVersion }, cache, now)).toBeUndefined()
    }
  })
})

describe("plugin installation scope", () => {
  test("detects project JSONC and global JSON installations", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-pr-tracker-update-"))
    directories.push(root)
    const projectConfigDirectory = join(root, "project", ".opencode")
    const globalConfigDirectory = join(root, "global")
    await mkdir(projectConfigDirectory, { recursive: true })
    await mkdir(globalConfigDirectory, { recursive: true })
    await writeFile(join(projectConfigDirectory, "tui.json"), `${JSON.stringify({ plugin: ["another-package"] })}\n`)
    await writeFile(
      join(projectConfigDirectory, "tui.jsonc"),
      '{\n  // project plugin\n  "plugin": [["@hcrosse/opencode-pr-tracker@0.2.0/tui", { "enabled": true }]],\n}\n',
    )
    await writeFile(
      join(globalConfigDirectory, "opencode.json"),
      `${JSON.stringify({ plugin: ["@hcrosse/opencode-pr-tracker/server"] })}\n`,
    )

    expect(await detectInstallationScopes({ projectConfigDirectory, globalConfigDirectory })).toEqual([
      "project",
      "global",
    ])
  })

  test("ignores unrelated and malformed config entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-pr-tracker-update-"))
    directories.push(root)
    const projectConfigDirectory = join(root, "project")
    const globalConfigDirectory = join(root, "global")
    await mkdir(projectConfigDirectory, { recursive: true })
    await mkdir(globalConfigDirectory, { recursive: true })
    await writeFile(join(projectConfigDirectory, "opencode.json"), '{"plugin":["another-package"]}\n')
    await writeFile(join(globalConfigDirectory, "tui.json"), '{"plugin":true}\n')

    expect(await detectInstallationScopes({ projectConfigDirectory, globalConfigDirectory })).toEqual([])
  })

  test("formats only detected scopes and shows both forms when scope is unknown", () => {
    expect(formatUpdateInstructions("0.2.1", ["project"])).toBe(
      "opencode plugin @hcrosse/opencode-pr-tracker@0.2.1 --force\n\nRestart OpenCode after updating.",
    )
    expect(formatUpdateInstructions("0.2.1", ["global"])).toBe(
      "opencode plugin @hcrosse/opencode-pr-tracker@0.2.1 --global --force\n\nRestart OpenCode after updating.",
    )
    expect(formatUpdateInstructions("0.2.1", [])).toBe(
      "Project installation:\nopencode plugin @hcrosse/opencode-pr-tracker@0.2.1 --force\n\nGlobal installation:\nopencode plugin @hcrosse/opencode-pr-tracker@0.2.1 --global --force\n\nRestart OpenCode after updating.",
    )
  })
})
