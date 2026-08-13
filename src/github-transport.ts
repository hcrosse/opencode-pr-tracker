import { execFile } from "node:child_process"

import type {
  GitHubAuthenticationRequired,
  GitHubCancelled,
  GitHubCliMissing,
  GitHubUnavailable,
  InvalidGitHubResponse,
} from "./github-types.js"
import type { Result } from "./url.js"

export type ProcessRunner = (
  file: string,
  args: readonly string[],
  options: Readonly<{ signal?: AbortSignal; cwd?: string }>,
) => Promise<Readonly<{ stdout: string }>>

type ProcessExecutionFailed = Readonly<{
  tag: "ProcessExecutionFailed"
  code: string | number | null
  stderr: string
  stdout: string
  cause: unknown
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseProcessExecutionFailed(value: unknown): ProcessExecutionFailed | undefined {
  if (
    !isRecord(value) ||
    value.tag !== "ProcessExecutionFailed" ||
    (value.code !== null && typeof value.code !== "string" && typeof value.code !== "number") ||
    typeof value.stderr !== "string" ||
    typeof value.stdout !== "string" ||
    !("cause" in value)
  ) {
    return undefined
  }

  return {
    tag: "ProcessExecutionFailed",
    code: value.code,
    stderr: value.stderr,
    stdout: value.stdout,
    cause: value.cause,
  }
}

function isCancellation(cause: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  const originalCause = parseProcessExecutionFailed(cause)?.cause ?? cause
  return originalCause instanceof Error && originalCause.name === "AbortError"
}

const authenticationFailureMarkers = ["http 401", "bad credentials", "not logged into", "gh auth login"] as const

function isAuthenticationFailure(failure: ProcessExecutionFailed): boolean {
  if (failure.code === 4) return true
  const stderr = failure.stderr.toLowerCase()
  return authenticationFailureMarkers.some((marker) => stderr.includes(marker))
}

function classifyProcessFailure(cause: unknown): GitHubCliMissing | GitHubAuthenticationRequired | GitHubUnavailable {
  const failure = parseProcessExecutionFailed(cause)
  if (failure?.code === "ENOENT") {
    return { tag: "GitHubCliMissing", message: "GitHub CLI is not installed", cause }
  }
  if (failure && isAuthenticationFailure(failure)) {
    return { tag: "GitHubAuthenticationRequired", message: "GitHub CLI authentication required", cause }
  }
  return { tag: "GitHubUnavailable", message: "GitHub status unavailable", cause }
}

function processFailureStdout(cause: unknown): string | undefined {
  if (!isRecord(cause) || typeof cause.stdout !== "string" || cause.stdout.trim() === "") return undefined
  return cause.stdout
}

export type ProcessFailure = GitHubCliMissing | GitHubAuthenticationRequired | GitHubUnavailable
export type DecodedProcessOutput = Readonly<{ decoded: unknown; processFailure?: ProcessFailure }>

const invalidGitHubResponse: Result<never, InvalidGitHubResponse> = {
  ok: false,
  error: {
    tag: "InvalidGitHubResponse",
    message: "GitHub returned an invalid pull request response",
  },
}

export async function runAndDecode(
  runner: ProcessRunner,
  args: readonly string[],
  options: Readonly<{ signal?: AbortSignal }>,
): Promise<Result<DecodedProcessOutput, ProcessFailure | GitHubCancelled | InvalidGitHubResponse>> {
  let stdout: string
  let processFailure: ProcessFailure | undefined
  try {
    const output = await runner("gh", args, options)
    stdout = output.stdout
  } catch (cause) {
    if (isCancellation(cause, options.signal)) {
      return {
        ok: false,
        error: {
          tag: "GitHubCancelled",
          message: "GitHub status request cancelled",
          cause,
        },
      }
    }
    processFailure = classifyProcessFailure(cause)
    const partialStdout = processFailureStdout(cause)
    if (partialStdout === undefined) return { ok: false, error: processFailure }
    stdout = partialStdout
  }

  let decoded: unknown
  try {
    decoded = JSON.parse(stdout)
  } catch {
    return processFailure === undefined ? invalidGitHubResponse : { ok: false, error: processFailure }
  }
  return { ok: true, value: { decoded, ...(processFailure === undefined ? {} : { processFailure }) } }
}

export const execFileRunner: ProcessRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject({
            tag: "ProcessExecutionFailed",
            code: error.code ?? null,
            stderr,
            stdout,
            cause: error,
          } satisfies ProcessExecutionFailed)
          return
        }
        resolve({ stdout })
      },
    )
  })
