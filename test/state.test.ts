import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createStateStore, defaultStateDirectory } from "../src/state.js"
import { parsePullRequestUrl, type PullRequestUrl } from "../src/url.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-pr-tracker-"))
  directories.push(directory)
  return directory
}

function pullRequest(number: number): PullRequestUrl {
  const result = parsePullRequestUrl(`https://github.com/owner/repository/pull/${number}`)
  if (!result.ok) throw new Error("test fixture URL is invalid")
  return result.value
}

describe("defaultStateDirectory", () => {
  test("uses OpenCode's XDG data directory", () => {
    expect(defaultStateDirectory({ XDG_DATA_HOME: "/custom/data" }, "/home/test")).toBe(
      "/custom/data/opencode/opencode-pr-tracker",
    )
    expect(defaultStateDirectory({}, "/home/test")).toBe("/home/test/.local/share/opencode/opencode-pr-tracker")
  })
})

describe("state store", () => {
  test("isolates sessions and persists canonical attachment identity", async () => {
    const directory = await temporaryDirectory()
    const store = createStateStore({
      directory,
      now: () => new Date("2026-08-10T12:00:00.000Z"),
    })

    expect(await store.attach("session-one", pullRequest(1))).toEqual({ ok: true, value: "added" })
    expect(await store.attach("session-one", pullRequest(1))).toEqual({ ok: true, value: "already_attached" })
    expect(await store.attach("session-two", pullRequest(2))).toEqual({ ok: true, value: "added" })

    expect(await store.list("session-one")).toEqual({
      ok: true,
      value: [
        {
          pullRequest: pullRequest(1),
          attachedAt: "2026-08-10T12:00:00.000Z",
        },
      ],
    })
    expect(await store.list("session-two")).toEqual({
      ok: true,
      value: [
        {
          pullRequest: pullRequest(2),
          attachedAt: "2026-08-10T12:00:00.000Z",
        },
      ],
    })

    const files = await readdir(directory)
    expect(files).toHaveLength(2)
    expect(files.every((file) => /^[a-f0-9]{64}\.json$/.test(file))).toBe(true)

    const persisted = await Promise.all(files.map((file) => readFile(join(directory, file), "utf8")))
    expect(new Set(persisted)).toEqual(
      new Set([
        `${JSON.stringify(
          {
            version: 1,
            pullRequests: [
              {
                url: "https://github.com/owner/repository/pull/1",
                attachedAt: "2026-08-10T12:00:00.000Z",
              },
            ],
          },
          null,
          2,
        )}\n`,
        `${JSON.stringify(
          {
            version: 1,
            pullRequests: [
              {
                url: "https://github.com/owner/repository/pull/2",
                attachedAt: "2026-08-10T12:00:00.000Z",
              },
            ],
          },
          null,
          2,
        )}\n`,
      ]),
    )
  })

  test("keeps opaque session IDs inside the configured directory", async () => {
    const directory = await temporaryDirectory()
    const store = createStateStore({ directory })

    expect(await store.attach("../../escape\0attempt", pullRequest(3))).toEqual({ ok: true, value: "added" })
    expect(await readdir(directory)).toEqual([expect.stringMatching(/^[a-f0-9]{64}\.json$/)])
  })

  test("limits each session to twenty attachments", async () => {
    const directory = await temporaryDirectory()
    const store = createStateStore({ directory })

    for (let number = 1; number <= 20; number += 1) {
      expect(await store.attach("session", pullRequest(number))).toEqual({ ok: true, value: "added" })
    }

    expect(await store.attach("session", pullRequest(21))).toEqual({
      ok: false,
      error: {
        tag: "AttachmentLimitReached",
        limit: 20,
        message: "A session can track at most 20 pull requests",
      },
    })
  })

  test("reports removed and absent detach outcomes", async () => {
    const directory = await temporaryDirectory()
    const store = createStateStore({ directory })
    await store.attach("session", pullRequest(1))

    expect(await store.detach("session", pullRequest(1))).toEqual({ ok: true, value: "removed" })
    expect(await store.detach("session", pullRequest(1))).toEqual({ ok: true, value: "absent" })
    expect(await store.list("session")).toEqual({ ok: true, value: [] })
  })

  test.each([
    "not json",
    JSON.stringify({ version: 2, pullRequests: [] }),
    JSON.stringify({ version: 1, pullRequests: [{ url: "not a URL", attachedAt: "2026-08-10T12:00:00.000Z" }] }),
  ])("fails closed without replacing invalid state: %s", async (content) => {
    const directory = await temporaryDirectory()
    const store = createStateStore({ directory })
    await store.attach("session", pullRequest(1))
    const [file] = await readdir(directory)
    await writeFile(join(directory, file!), content)

    const result = await store.attach("session", pullRequest(2))

    expect(result).toEqual({
      ok: false,
      error: {
        tag: "InvalidStateFile",
        message: "The session pull request state file is invalid",
      },
    })
    expect(await readFile(join(directory, file!), "utf8")).toBe(content)
  })

  test("reloads the current file before every write", async () => {
    const directory = await temporaryDirectory()
    const store = createStateStore({ directory, now: () => new Date("2026-08-10T12:00:00.000Z") })
    await store.attach("session", pullRequest(1))
    const [file] = await readdir(directory)
    await writeFile(
      join(directory, file!),
      `${JSON.stringify({
        version: 1,
        pullRequests: [
          { url: pullRequest(1).url, attachedAt: "2026-08-10T12:00:00.000Z" },
          { url: pullRequest(2).url, attachedAt: "2026-08-10T12:00:00.000Z" },
        ],
      })}\n`,
    )

    expect(await store.attach("session", pullRequest(3))).toEqual({ ok: true, value: "added" })
    const result = await store.list("session")
    expect(result.ok && result.value.map((item) => item.pullRequest.number)).toEqual([1, 2, 3])
    expect((await readdir(directory)).every((name) => !name.endsWith(".tmp"))).toBe(true)
  })

  test("preserves concurrent attachments from separate stores", async () => {
    const directory = await temporaryDirectory()
    const firstStore = createStateStore({ directory })
    const secondStore = createStateStore({ directory })

    await Promise.all([firstStore.attach("session", pullRequest(1)), secondStore.attach("session", pullRequest(2))])

    const result = await firstStore.list("session")
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected state to be readable")
    expect(new Set(result.value.map((item) => item.pullRequest.number))).toEqual(new Set([1, 2]))
  })

  test("recovers a stale lock left by a terminated process", async () => {
    const directory = await temporaryDirectory()
    const store = createStateStore({ directory })
    await store.attach("session", pullRequest(1))
    const [stateFile] = await readdir(directory)
    const lockDirectory = join(directory, `${stateFile}.lock`)
    await mkdir(lockDirectory)
    const staleTime = new Date(Date.now() - 60_000)
    await utimes(lockDirectory, staleTime, staleTime)

    expect(await store.attach("session", pullRequest(2))).toEqual({ ok: true, value: "added" })
  })
})
