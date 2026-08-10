import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { lock as lockFile } from "proper-lockfile"

import { parsePullRequestUrl, type PullRequestUrl, type Result } from "./url.js"

export const maximumPullRequestsPerSession = 20

export type PullRequestAttachment = Readonly<{
  pullRequest: PullRequestUrl
  attachedAt: string
}>

export type InvalidStateFile = Readonly<{
  tag: "InvalidStateFile"
  message: "The session pull request state file is invalid"
}>

export type StateUnavailable = Readonly<{
  tag: "StateUnavailable"
  operation: "read" | "write"
  message: string
  cause: unknown
}>

export type AttachmentLimitReached = Readonly<{
  tag: "AttachmentLimitReached"
  limit: 20
  message: "A session can track at most 20 pull requests"
}>

export type StateFailure = InvalidStateFile | StateUnavailable
export type AttachFailure = StateFailure | AttachmentLimitReached

export type StateStore = Readonly<{
  list(sessionID: string): Promise<Result<readonly PullRequestAttachment[], StateFailure>>
  attach(sessionID: string, pullRequest: PullRequestUrl): Promise<Result<"added" | "already_attached", AttachFailure>>
  detach(sessionID: string, pullRequest: PullRequestUrl): Promise<Result<"removed" | "absent", StateFailure>>
}>

type PersistedState = Readonly<{
  version: 1
  pullRequests: readonly Readonly<{ url: string; attachedAt: string }>[]
}>

const invalidStateFile: Result<never, InvalidStateFile> = {
  ok: false,
  error: {
    tag: "InvalidStateFile",
    message: "The session pull request state file is invalid",
  },
}

const lockStaleMilliseconds = 10_000
const lockUpdateMilliseconds = 2_000

function stateUnavailable(operation: "read" | "write", message: string, cause: unknown): StateUnavailable {
  return { tag: "StateUnavailable", operation, message, cause }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function parseState(input: unknown): Result<readonly PullRequestAttachment[], InvalidStateFile> {
  if (!isRecord(input) || !hasExactKeys(input, ["version", "pullRequests"])) return invalidStateFile
  if (input.version !== 1 || !Array.isArray(input.pullRequests)) return invalidStateFile
  if (input.pullRequests.length > maximumPullRequestsPerSession) return invalidStateFile

  const attachments: PullRequestAttachment[] = []
  const seen = new Set<string>()
  for (const item of input.pullRequests) {
    if (!isRecord(item) || !hasExactKeys(item, ["url", "attachedAt"])) return invalidStateFile
    if (typeof item.url !== "string" || typeof item.attachedAt !== "string") return invalidStateFile

    const parsed = parsePullRequestUrl(item.url)
    if (!parsed.ok || parsed.value.url !== item.url || seen.has(item.url)) return invalidStateFile

    const attachedAt = new Date(item.attachedAt)
    if (Number.isNaN(attachedAt.valueOf()) || attachedAt.toISOString() !== item.attachedAt) return invalidStateFile

    seen.add(item.url)
    attachments.push({ pullRequest: parsed.value, attachedAt: item.attachedAt })
  }

  return { ok: true, value: attachments }
}

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT"
}

function fileName(sessionID: string): string {
  return `${createHash("sha256").update(sessionID).digest("hex")}.json`
}

export function defaultStateDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const dataHome = environment.XDG_DATA_HOME || join(home, ".local", "share")
  return join(dataHome, "opencode", "opencode-pr-tracker")
}

export function createStateStore(options: Readonly<{ directory?: string; now?: () => Date }> = {}): StateStore {
  const directory = options.directory ?? defaultStateDirectory()
  const now = options.now ?? (() => new Date())

  async function acquireLock(sessionID: string): Promise<
    Result<
      Readonly<{
        release(): Promise<void>
        compromised(): Error | undefined
      }>,
      StateUnavailable
    >
  > {
    const stateFile = join(directory, fileName(sessionID))
    let compromised: Error | undefined
    try {
      await mkdir(directory, { recursive: true })
      const release = await lockFile(stateFile, {
        realpath: false,
        stale: lockStaleMilliseconds,
        update: lockUpdateMilliseconds,
        retries: { retries: 50, factor: 1, minTimeout: 10, maxTimeout: 100 },
        onCompromised: (error) => {
          compromised = error
        },
      })
      return { ok: true, value: { release, compromised: () => compromised } }
    } catch (cause) {
      return {
        ok: false,
        error: stateUnavailable("write", "Unable to lock the session pull request state", cause),
      }
    }
  }

  async function withLock<Value, Failure>(
    sessionID: string,
    operation: () => Promise<Result<Value, Failure>>,
  ): Promise<Result<Value, Failure | StateUnavailable>> {
    const lock = await acquireLock(sessionID)
    if (!lock.ok) return lock
    let result: Result<Value, Failure>
    try {
      result = await operation()
    } catch (cause) {
      await lock.value.release().catch(() => undefined)
      throw cause
    }

    try {
      await lock.value.release()
    } catch (cause) {
      return {
        ok: false,
        error: stateUnavailable("write", "Unable to unlock the session pull request state", cause),
      }
    }

    const compromise = lock.value.compromised()
    if (compromise !== undefined) {
      return {
        ok: false,
        error: stateUnavailable("write", "The session pull request state lock was compromised", compromise),
      }
    }
    return result
  }

  async function read(sessionID: string): Promise<Result<readonly PullRequestAttachment[], StateFailure>> {
    const path = join(directory, fileName(sessionID))
    let content: string
    try {
      content = await readFile(path, "utf8")
    } catch (cause) {
      if (isMissingFile(cause)) return { ok: true, value: [] }
      return {
        ok: false,
        error: {
          tag: "StateUnavailable",
          operation: "read",
          message: "Unable to read the session pull request state",
          cause,
        },
      }
    }

    let decoded: unknown
    try {
      decoded = JSON.parse(content)
    } catch {
      return invalidStateFile
    }
    return parseState(decoded)
  }

  async function write(
    sessionID: string,
    attachments: readonly PullRequestAttachment[],
  ): Promise<Result<void, StateUnavailable>> {
    const destination = join(directory, fileName(sessionID))
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
    const state: PersistedState = {
      version: 1,
      pullRequests: attachments.map((attachment) => ({
        url: attachment.pullRequest.url,
        attachedAt: attachment.attachedAt,
      })),
    }

    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, destination)
      return { ok: true, value: undefined }
    } catch (cause) {
      await rm(temporary, { force: true }).catch(() => undefined)
      return {
        ok: false,
        error: {
          tag: "StateUnavailable",
          operation: "write",
          message: "Unable to write the session pull request state",
          cause,
        },
      }
    }
  }

  return {
    list: read,
    async attach(sessionID, pullRequest) {
      return withLock<"added" | "already_attached", AttachFailure>(sessionID, async () => {
        const current = await read(sessionID)
        if (!current.ok) return current
        if (current.value.some((attachment) => attachment.pullRequest.url === pullRequest.url)) {
          return { ok: true, value: "already_attached" } as const
        }
        if (current.value.length >= maximumPullRequestsPerSession) {
          return {
            ok: false,
            error: {
              tag: "AttachmentLimitReached",
              limit: maximumPullRequestsPerSession,
              message: "A session can track at most 20 pull requests",
            },
          } as const
        }

        const written = await write(sessionID, [...current.value, { pullRequest, attachedAt: now().toISOString() }])
        if (!written.ok) return written
        return { ok: true, value: "added" } as const
      })
    },
    async detach(sessionID, pullRequest) {
      return withLock<"removed" | "absent", StateFailure>(sessionID, async () => {
        const current = await read(sessionID)
        if (!current.ok) return current
        const next = current.value.filter((attachment) => attachment.pullRequest.url !== pullRequest.url)
        if (next.length === current.value.length) return { ok: true, value: "absent" } as const

        const written = await write(sessionID, next)
        if (!written.ok) return written
        return { ok: true, value: "removed" } as const
      })
    },
  }
}
