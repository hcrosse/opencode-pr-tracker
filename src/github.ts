import { execFile } from "node:child_process"

import { casesHandled } from "./exhaustive.js"
import { parsePullRequestUrl, type PullRequestUrl, type Result } from "./url.js"

export type PullRequestCi = "passed" | "pending" | "failed" | "none"

export type PullRequestState =
  | Readonly<{ tag: "Open"; ci: PullRequestCi }>
  | Readonly<{ tag: "Merged" }>
  | Readonly<{ tag: "Closed" }>

export type AvailablePullRequestStatus = Readonly<{
  tag: "Available"
  pullRequest: PullRequestUrl
  title: string
  state: PullRequestState
  stale: boolean
}>

export type PullRequestStatus = AvailablePullRequestStatus | Readonly<{ tag: "Unavailable" }>

export type GitHubUnavailable = Readonly<{
  tag: "GitHubUnavailable"
  message: "GitHub status unavailable"
  cause: unknown
}>

export type GitHubCancelled = Readonly<{
  tag: "GitHubCancelled"
  message: "GitHub status request cancelled"
  cause: unknown
}>

export type InvalidGitHubResponse = Readonly<{
  tag: "InvalidGitHubResponse"
  message: "GitHub returned an invalid pull request response"
}>

export type GitHubFailure = GitHubUnavailable | GitHubCancelled | InvalidGitHubResponse

export type ProcessRunner = (
  file: string,
  args: readonly string[],
  options: Readonly<{ signal?: AbortSignal }>,
) => Promise<Readonly<{ stdout: string }>>

export type GitHubClient = Readonly<{
  get(
    pullRequest: PullRequestUrl,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Result<AvailablePullRequestStatus, GitHubFailure>>
}>

const invalidGitHubResponse: Result<never, InvalidGitHubResponse> = {
  ok: false,
  error: {
    tag: "InvalidGitHubResponse",
    message: "GitHub returned an invalid pull request response",
  },
}

const checkRunPending = new Set(["QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "PENDING"])
const checkRunPassed = new Set(["SUCCESS"])
const checkRunFailed = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"])
const checkRunIgnored = new Set(["NEUTRAL", "SKIPPED"])

type ParsedLifecycle = "open" | "merged" | "closed"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseCheck(input: unknown): Result<"passed" | "pending" | "failed" | "ignored", InvalidGitHubResponse> {
  if (!isRecord(input) || typeof input.__typename !== "string") return invalidGitHubResponse

  if (input.__typename === "StatusContext") {
    if (input.state === "SUCCESS") return { ok: true, value: "passed" }
    if (input.state === "PENDING" || input.state === "EXPECTED") return { ok: true, value: "pending" }
    if (input.state === "FAILURE" || input.state === "ERROR") return { ok: true, value: "failed" }
    return invalidGitHubResponse
  }

  if (input.__typename !== "CheckRun" || typeof input.status !== "string") return invalidGitHubResponse
  if (checkRunPending.has(input.status)) return { ok: true, value: "pending" }
  if (input.status !== "COMPLETED" || typeof input.conclusion !== "string") return invalidGitHubResponse
  if (checkRunPassed.has(input.conclusion)) return { ok: true, value: "passed" }
  if (checkRunFailed.has(input.conclusion)) return { ok: true, value: "failed" }
  if (checkRunIgnored.has(input.conclusion)) return { ok: true, value: "ignored" }
  return invalidGitHubResponse
}

function aggregateChecks(input: unknown): Result<PullRequestCi, InvalidGitHubResponse> {
  if (!Array.isArray(input)) return invalidGitHubResponse

  let passed = false
  let pending = false
  for (const rawCheck of input) {
    const check = parseCheck(rawCheck)
    if (!check.ok) return check
    switch (check.value) {
      case "failed":
        return { ok: true, value: "failed" }
      case "pending":
        pending = true
        break
      case "passed":
        passed = true
        break
      case "ignored":
        break
      default:
        return casesHandled(check.value)
    }
  }

  if (pending) return { ok: true, value: "pending" }
  if (passed) return { ok: true, value: "passed" }
  return { ok: true, value: "none" }
}

function samePullRequest(left: PullRequestUrl, right: PullRequestUrl): boolean {
  return (
    left.number === right.number &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repository.toLowerCase() === right.repository.toLowerCase()
  )
}

function parseResponse(
  input: unknown,
  pullRequest: PullRequestUrl,
): Result<AvailablePullRequestStatus, InvalidGitHubResponse> {
  if (!isRecord(input) || typeof input.title !== "string" || input.title.trim() === "") {
    return invalidGitHubResponse
  }
  if (input.state !== "OPEN" && input.state !== "CLOSED" && input.state !== "MERGED") {
    return invalidGitHubResponse
  }
  if (input.mergedAt !== null && typeof input.mergedAt !== "string") return invalidGitHubResponse
  if (typeof input.mergedAt === "string" && Number.isNaN(new Date(input.mergedAt).valueOf())) {
    return invalidGitHubResponse
  }
  if (input.state === "MERGED" && typeof input.mergedAt !== "string") return invalidGitHubResponse
  if (input.state !== "MERGED" && input.mergedAt !== null) return invalidGitHubResponse
  if (typeof input.url !== "string") return invalidGitHubResponse

  const responseUrl = parsePullRequestUrl(input.url)
  if (!responseUrl.ok || !samePullRequest(responseUrl.value, pullRequest)) return invalidGitHubResponse

  const ci = aggregateChecks(input.statusCheckRollup)
  if (!ci.ok) return ci

  const lifecycle: ParsedLifecycle = input.state === "MERGED" ? "merged" : input.state === "CLOSED" ? "closed" : "open"
  let state: PullRequestState
  switch (lifecycle) {
    case "open":
      state = { tag: "Open", ci: ci.value }
      break
    case "merged":
      state = { tag: "Merged" }
      break
    case "closed":
      state = { tag: "Closed" }
      break
    default:
      return casesHandled(lifecycle)
  }

  return {
    ok: true,
    value: {
      tag: "Available",
      pullRequest,
      title: input.title,
      state,
      stale: false,
    },
  }
}

function isCancellation(cause: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  return cause instanceof Error && cause.name === "AbortError"
}

export const execFileRunner: ProcessRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: "utf8", ...(options.signal ? { signal: options.signal } : {}) },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve({ stdout })
      },
    )
  })

export function createGitHubClient(runner: ProcessRunner = execFileRunner): GitHubClient {
  return {
    async get(pullRequest, options = {}) {
      let stdout: string
      try {
        const output = await runner(
          "gh",
          ["pr", "view", pullRequest.url, "--json", "title,state,url,mergedAt,statusCheckRollup"],
          options,
        )
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
        return {
          ok: false,
          error: {
            tag: "GitHubUnavailable",
            message: "GitHub status unavailable",
            cause,
          },
        }
      }

      let decoded: unknown
      try {
        decoded = JSON.parse(stdout)
      } catch {
        return invalidGitHubResponse
      }
      return parseResponse(decoded, pullRequest)
    },
  }
}

export type StatusAppearance = Readonly<{
  tone: "green" | "yellow" | "red" | "purple" | "gray"
  label: string
  strikethrough: boolean
}>

export function statusAppearance(status: PullRequestStatus): StatusAppearance {
  let appearance: StatusAppearance
  switch (status.tag) {
    case "Unavailable":
      return { tone: "gray", label: "status unavailable", strikethrough: false }
    case "Available":
      switch (status.state.tag) {
        case "Open":
          switch (status.state.ci) {
            case "passed":
              appearance = { tone: "green", label: "checks passed", strikethrough: false }
              break
            case "pending":
              appearance = { tone: "yellow", label: "checks pending", strikethrough: false }
              break
            case "failed":
              appearance = { tone: "red", label: "checks failed", strikethrough: false }
              break
            case "none":
              appearance = { tone: "gray", label: "no checks", strikethrough: false }
              break
            default:
              return casesHandled(status.state.ci)
          }
          break
        case "Merged":
          appearance = { tone: "purple", label: "merged", strikethrough: true }
          break
        case "Closed":
          appearance = { tone: "red", label: "closed", strikethrough: true }
          break
        default:
          return casesHandled(status.state)
      }
      break
    default:
      return casesHandled(status)
  }

  return status.stale ? { ...appearance, label: `${appearance.label} (stale)` } : appearance
}
