import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createStateStore, defaultStateDirectory } from "../src/state.js"
import { parsePullRequestUrl, type NonEmptyPullRequests, type PullRequestUrl } from "../src/url.js"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-pr-tracker-"))
  directories.push(directory)
  return directory
}

function pullRequest(number: number, repository = "repository"): PullRequestUrl {
  const result = parsePullRequestUrl(`https://github.com/owner/${repository}/pull/${number}`)
  if (!result.ok) throw new Error("test fixture URL is invalid")
  return result.value
}

function deferred(): Readonly<{ promise: Promise<void>; resolve(): void }> {
  let resolve!: () => void
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
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
  test("uses the configured file lock", async () => {
    const directory = await temporaryDirectory()
    const cause = new Error("injected lock failure")
    const lock: typeof import("proper-lockfile").lock = async () => {
      throw cause
    }
    const store = createStateStore({ directory, lock })

    expect(await store.attach("session", pullRequest(1))).toEqual({
      ok: false,
      error: {
        tag: "StateUnavailable",
        operation: "write",
        message: "Unable to lock the session pull request state",
        cause,
      },
    })
  })

  test("preserves same-store attachment invocation order", async () => {
    const directory = await temporaryDirectory()
    const firstLockStarted = deferred()
    const continueFirstLock = deferred()
    let lockAttempts = 0
    const lock: typeof import("proper-lockfile").lock = async () => {
      lockAttempts += 1
      if (lockAttempts === 1) {
        firstLockStarted.resolve()
        await continueFirstLock.promise
      }
      return async () => undefined
    }
    const store = createStateStore({ directory, lock })

    const first = store.attach("session", pullRequest(1))
    await firstLockStarted.promise
    const second = store.attach("session", pullRequest(2))
    const overtook = await Promise.race([second.then(() => true), Bun.sleep(50).then(() => false)])

    expect(overtook).toBe(false)
    expect(lockAttempts).toBe(1)
    continueFirstLock.resolve()
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, value: "added" },
      { ok: true, value: "added" },
    ])
    const attachments = await store.list("session")
    expect(attachments.ok && attachments.value.map((item) => item.pullRequest.number)).toEqual([1, 2])
  })

  test("does not serialize attachments across sessions", async () => {
    const directory = await temporaryDirectory()
    const firstLockStarted = deferred()
    const continueFirstLock = deferred()
    let lockAttempts = 0
    const lock: typeof import("proper-lockfile").lock = async () => {
      lockAttempts += 1
      if (lockAttempts === 1) {
        firstLockStarted.resolve()
        await continueFirstLock.promise
      }
      return async () => undefined
    }
    const store = createStateStore({ directory, lock })

    const first = store.attach("session-one", pullRequest(1))
    await firstLockStarted.promise
    const second = store.attach("session-two", pullRequest(2))

    expect(await second).toEqual({ ok: true, value: "added" })
    expect(lockAttempts).toBe(2)
    continueFirstLock.resolve()
    expect(await first).toEqual({ ok: true, value: "added" })
    const firstAttachments = await store.list("session-one")
    const secondAttachments = await store.list("session-two")
    expect(firstAttachments.ok && firstAttachments.value.map((item) => item.pullRequest.number)).toEqual([1])
    expect(secondAttachments.ok && secondAttachments.value.map((item) => item.pullRequest.number)).toEqual([2])
  })

  test("releases the attachment queue after an exception", async () => {
    const directory = await temporaryDirectory()
    const cause = new Error("injected timestamp failure")
    let calls = 0
    const store = createStateStore({
      directory,
      now: () => {
        calls += 1
        if (calls === 1) throw cause
        return new Date("2026-08-10T12:00:00.000Z")
      },
    })

    const first = store.attach("session", pullRequest(1))
    const second = store.attach("session", pullRequest(2))

    expect(first).rejects.toBe(cause)
    expect(await second).toEqual({ ok: true, value: "added" })
    const attachments = await store.list("session")
    expect(attachments.ok && attachments.value.map((item) => item.pullRequest.number)).toEqual([2])
  })

  test("runs queued validation before locking and skips it for existing attachments", async () => {
    const directory = await temporaryDirectory()
    const events: string[] = []
    const lock: typeof import("proper-lockfile").lock = async () => {
      events.push("lock")
      return async () => undefined
    }
    const store = createStateStore({ directory, lock })

    expect(
      await store.attach("session", pullRequest(1), {
        async validate() {
          events.push("validate")
          return { ok: true, value: undefined }
        },
      }),
    ).toEqual({ ok: true, value: "added" })
    expect(events).toEqual(["validate", "lock"])

    expect(
      await store.attach("session", pullRequest(1), {
        async validate() {
          throw new Error("validation must not run for an existing attachment")
        },
      }),
    ).toEqual({ ok: true, value: "already_attached" })
    expect(events).toEqual(["validate", "lock"])
  })

  test("attachment group inserts at its earliest member and preserves attachment timestamps", async () => {
    const directory = await temporaryDirectory()
    const timestamps = [
      "2026-08-10T12:00:00.000Z",
      "2026-08-10T12:01:00.000Z",
      "2026-08-10T12:02:00.000Z",
      "2026-08-10T12:03:00.000Z",
      "2026-08-10T12:04:00.000Z",
    ] as const
    let timestampIndex = 0
    const store = createStateStore({
      directory,
      now: () => new Date(timestamps[timestampIndex++]!),
    })
    for (const number of [91, 3, 92, 1]) {
      expect(await store.attach("session", pullRequest(number))).toEqual({ ok: true, value: "added" })
    }

    expect(
      await store.attachGroup("session", async () => ({
        ok: true,
        value: [pullRequest(1), pullRequest(2), pullRequest(3)],
      })),
    ).toEqual({ ok: true, value: "added" })

    const attachments = await store.list("session")
    expect(attachments.ok).toBe(true)
    if (!attachments.ok) throw new Error("expected state to be readable")
    expect(attachments.value.map(({ pullRequest: item }) => item.number)).toEqual([91, 1, 2, 3, 92])
    expect(
      Object.fromEntries(
        attachments.value.map(({ pullRequest: item, attachedAt }) => [item.number, attachedAt] as const),
      ),
    ).toEqual({
      1: timestamps[3],
      2: timestamps[4],
      3: timestamps[1],
      91: timestamps[0],
      92: timestamps[2],
    })

    const [stateFile] = await readdir(directory)
    const path = join(directory, stateFile!)
    const beforeContent = await readFile(path, "utf8")
    const beforeInode = (await stat(path)).ino
    expect(
      await store.attachGroup("session", async () => ({
        ok: true,
        value: [pullRequest(1), pullRequest(2), pullRequest(3)],
      })),
    ).toEqual({ ok: true, value: "already_attached" })
    expect(await readFile(path, "utf8")).toBe(beforeContent)
    expect((await stat(path)).ino).toBe(beforeInode)
    expect(timestampIndex).toBe(5)
  })

  test("attachment group canonically deduplicates members and timestamps new members once", async () => {
    const directory = await temporaryDirectory()
    let timestampCalls = 0
    const store = createStateStore({
      directory,
      now: () => {
        timestampCalls += 1
        return new Date("2026-08-10T12:00:00.000Z")
      },
    })
    const mixedCase = parsePullRequestUrl("https://github.com/Owner/Repository/pull/1")
    if (!mixedCase.ok) throw new Error("test fixture URL is invalid")

    expect(
      await store.attachGroup("session", async () => ({
        ok: true,
        value: [mixedCase.value, pullRequest(1), pullRequest(2), pullRequest(3)],
      })),
    ).toEqual({ ok: true, value: "added" })

    const attachments = await store.list("session")
    expect(attachments.ok && attachments.value.map(({ pullRequest: item }) => item.number)).toEqual([1, 2, 3])
    expect(attachments.ok && new Set(attachments.value.map(({ attachedAt }) => attachedAt))).toEqual(
      new Set(["2026-08-10T12:00:00.000Z"]),
    )
    expect(timestampCalls).toBe(1)
  })

  test("attachment group returns resolution failure without locking or writing", async () => {
    const directory = await temporaryDirectory()
    const seedStore = createStateStore({ directory })
    await seedStore.attach("session", pullRequest(1))
    const [stateFile] = await readdir(directory)
    const path = join(directory, stateFile!)
    const beforeContent = await readFile(path, "utf8")
    const beforeInode = (await stat(path)).ino
    let lockAttempts = 0
    const store = createStateStore({
      directory,
      lock: async () => {
        lockAttempts += 1
        throw new Error("lock must not be acquired")
      },
    })
    const resolutionFailure = { tag: "ResolutionFailure" } as const

    expect(await store.attachGroup("session", async () => ({ ok: false, error: resolutionFailure }))).toEqual({
      ok: false,
      error: resolutionFailure,
    })
    expect(lockAttempts).toBe(0)
    expect(await readFile(path, "utf8")).toBe(beforeContent)
    expect((await stat(path)).ino).toBe(beforeInode)
  })

  test("attachment group surfaces corrupt state before resolving", async () => {
    const directory = await temporaryDirectory()
    const store = createStateStore({ directory })
    await store.attach("session", pullRequest(1))
    const [stateFile] = await readdir(directory)
    const path = join(directory, stateFile!)
    const content = "not json"
    await writeFile(path, content)
    let resolutionCalls = 0

    expect(
      await store.attachGroup("session", async () => {
        resolutionCalls += 1
        return { ok: true, value: [pullRequest(2)] }
      }),
    ).toEqual({
      ok: false,
      error: {
        tag: "InvalidStateFile",
        message: "The session pull request state file is invalid",
      },
    })
    expect(resolutionCalls).toBe(0)
    expect(await readFile(path, "utf8")).toBe(content)
  })

  test("attachment group does not write when the unique union exceeds the session limit", async () => {
    const directory = await temporaryDirectory()
    const store = createStateStore({ directory })
    for (let number = 1; number <= 20; number += 1) {
      await store.attach("session", pullRequest(number))
    }
    const [stateFile] = await readdir(directory)
    const path = join(directory, stateFile!)
    const beforeContent = await readFile(path, "utf8")
    const beforeInode = (await stat(path)).ino

    expect(
      await store.attachGroup("session", async () => ({
        ok: true,
        value: [pullRequest(1), pullRequest(21)],
      })),
    ).toEqual({
      ok: false,
      error: {
        tag: "AttachmentLimitReached",
        limit: 20,
        message: "A session can track at most 20 pull requests",
      },
    })
    expect(await readFile(path, "utf8")).toBe(beforeContent)
    expect((await stat(path)).ino).toBe(beforeInode)
  })

  test("attachment group checks capacity after its locked reread", async () => {
    const directory = await temporaryDirectory()
    const firstStore = createStateStore({ directory })
    const secondStore = createStateStore({ directory })
    for (let number = 1; number <= 19; number += 1) {
      await firstStore.attach("session", pullRequest(number))
    }
    const resolutionStarted = deferred()
    const continueResolution = deferred()
    const group = firstStore.attachGroup("session", async () => {
      resolutionStarted.resolve()
      await continueResolution.promise
      return { ok: true, value: [pullRequest(21)] }
    })
    await resolutionStarted.promise
    expect(await secondStore.attach("session", pullRequest(20))).toEqual({ ok: true, value: "added" })
    continueResolution.resolve()

    expect(await group).toEqual({
      ok: false,
      error: {
        tag: "AttachmentLimitReached",
        limit: 20,
        message: "A session can track at most 20 pull requests",
      },
    })
    const attachments = await firstStore.list("session")
    expect(attachments.ok && attachments.value.map(({ pullRequest: item }) => item.number)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    )
  })

  test("attachment group resolution follows same-session FIFO before locking", async () => {
    const directory = await temporaryDirectory()
    const firstResolutionStarted = deferred()
    const continueFirstResolution = deferred()
    const events: string[] = []
    const lock: typeof import("proper-lockfile").lock = async () => {
      events.push("lock")
      return async () => undefined
    }
    const store = createStateStore({ directory, lock })

    const first = store.attachGroup("session", async () => {
      events.push("resolve-first")
      firstResolutionStarted.resolve()
      await continueFirstResolution.promise
      return { ok: true, value: [pullRequest(1), pullRequest(2)] }
    })
    await firstResolutionStarted.promise
    const second = store.attachGroup("session", async () => {
      events.push("resolve-second")
      return { ok: true, value: [pullRequest(3)] }
    })
    await Bun.sleep(50)

    expect(events).toEqual(["resolve-first"])
    continueFirstResolution.resolve()
    expect(await Promise.all([first, second])).toEqual([
      { ok: true, value: "added" },
      { ok: true, value: "added" },
    ])
    expect(events).toEqual(["resolve-first", "lock", "resolve-second", "lock"])
    const attachments = await store.list("session")
    expect(attachments.ok && attachments.value.map(({ pullRequest: item }) => item.number)).toEqual([1, 2, 3])
  })

  test("attachment group locks concurrent transactions from separate stores", async () => {
    const directory = await temporaryDirectory()
    const firstStore = createStateStore({ directory })
    const secondStore = createStateStore({ directory })
    const bothResolved = deferred()
    let resolutionCount = 0
    const resolve = (value: NonEmptyPullRequests) => async () => {
      resolutionCount += 1
      if (resolutionCount === 2) bothResolved.resolve()
      await bothResolved.promise
      return { ok: true, value } as const
    }

    expect(
      await Promise.all([
        firstStore.attachGroup("session", resolve([pullRequest(1), pullRequest(2)])),
        secondStore.attachGroup("session", resolve([pullRequest(3), pullRequest(4)])),
      ]),
    ).toEqual([
      { ok: true, value: "added" },
      { ok: true, value: "added" },
    ])
    const attachments = await firstStore.list("session")
    const numbers = attachments.ok ? attachments.value.map(({ pullRequest: item }) => item.number) : []
    expect([
      [1, 2, 3, 4],
      [3, 4, 1, 2],
    ]).toContainEqual(numbers)
  })

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

  test("treats pull request casing variants as one attachment", async () => {
    const directory = await temporaryDirectory()
    const store = createStateStore({ directory })
    const mixedCase = parsePullRequestUrl("https://github.com/Owner/Repository/pull/1")
    if (!mixedCase.ok) throw new Error("test fixture URL is invalid")

    expect(await store.attach("session", mixedCase.value)).toEqual({ ok: true, value: "added" })
    expect(await store.attach("session", pullRequest(1))).toEqual({ ok: true, value: "already_attached" })
    expect(await store.detach("session", mixedCase.value)).toEqual({ ok: true, value: "removed" })
    expect(await store.list("session")).toEqual({ ok: true, value: [] })
  })

  test("rejects persisted pull request URLs with non-normalized casing", async () => {
    const directory = await temporaryDirectory()
    const store = createStateStore({ directory })
    await store.attach("session", pullRequest(1))
    const [file] = await readdir(directory)
    await writeFile(
      join(directory, file!),
      `${JSON.stringify({
        version: 1,
        pullRequests: [
          {
            url: "https://github.com/Owner/Repository/pull/1",
            attachedAt: "2026-08-10T12:00:00.000Z",
          },
        ],
      })}\n`,
    )

    expect(await store.list("session")).toEqual({
      ok: false,
      error: {
        tag: "InvalidStateFile",
        message: "The session pull request state file is invalid",
      },
    })
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

  test("atomically resolves attach and numeric detach races across stores", async () => {
    const directory = await temporaryDirectory()
    const firstStore = createStateStore({ directory })
    const secondStore = createStateStore({ directory })
    await firstStore.attach("session", pullRequest(1))

    const [detached, attached] = await Promise.all([
      firstStore.detachByNumber("session", 1),
      secondStore.attach("session", pullRequest(1, "another")),
    ])

    expect(attached).toEqual({ ok: true, value: "added" })
    expect(detached.ok).toBe(true)
    if (!detached.ok) throw new Error("expected numeric detach to complete")
    const current = await firstStore.list("session")
    if (!current.ok) throw new Error("expected state to be readable")
    if (detached.value.tag === "removed") {
      expect(current.value.map((item) => item.pullRequest.url)).toEqual([pullRequest(1, "another").url])
    } else {
      expect(detached.value.tag).toBe("ambiguous")
      expect(new Set(current.value.map((item) => item.pullRequest.url))).toEqual(
        new Set([pullRequest(1).url, pullRequest(1, "another").url]),
      )
    }
  })

  test("serializes concurrent numeric detaches across stores", async () => {
    const directory = await temporaryDirectory()
    const firstStore = createStateStore({ directory })
    const secondStore = createStateStore({ directory })
    await firstStore.attach("session", pullRequest(1))

    const results = await Promise.all([
      firstStore.detachByNumber("session", 1),
      secondStore.detachByNumber("session", 1),
    ])

    expect(results.every((result) => result.ok)).toBe(true)
    expect(new Set(results.map((result) => (result.ok ? result.value.tag : "error")))).toEqual(
      new Set(["absent", "removed"]),
    )
    expect(await firstStore.list("session")).toEqual({ ok: true, value: [] })
  })

  test("treats cleanup of missing session state as absent", async () => {
    const directory = await temporaryDirectory()
    const store = createStateStore({ directory })

    expect(await store.removeSession("missing")).toEqual({ ok: true, value: "absent" })
    expect(await readdir(directory)).toEqual([])
  })

  test("preserves corrupt session state during cleanup", async () => {
    const directory = await temporaryDirectory()
    const store = createStateStore({ directory })
    await store.attach("session", pullRequest(1))
    const [stateFile] = await readdir(directory)
    const path = join(directory, stateFile!)
    const content = `${JSON.stringify({ version: 2, pullRequests: [] })}\n`
    await writeFile(path, content)

    expect(await store.removeSession("session")).toEqual({
      ok: false,
      error: {
        tag: "InvalidStateFile",
        message: "The session pull request state file is invalid",
      },
    })
    expect(await readFile(path, "utf8")).toBe(content)
  })

  test("serializes session cleanup with concurrent writes", async () => {
    const directory = await temporaryDirectory()
    const firstStore = createStateStore({ directory })
    const secondStore = createStateStore({ directory })
    await firstStore.attach("session", pullRequest(1))

    const [removed, attached] = await Promise.all([
      firstStore.removeSession("session"),
      secondStore.attach("session", pullRequest(2)),
    ])

    expect(removed).toEqual({ ok: true, value: "removed" })
    expect(attached).toEqual({ ok: true, value: "added" })
    const current = await firstStore.list("session")
    if (!current.ok) throw new Error("expected state to be readable")
    expect(current.value.map((item) => item.pullRequest.number)).not.toContain(1)
    expect([[], [2]]).toContainEqual(current.value.map((item) => item.pullRequest.number))
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
