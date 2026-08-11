import { execFile } from "node:child_process"

import { casesHandled } from "./exhaustive.js"
import { parsePullRequestUrl, type PullRequestUrl, type Result } from "./url.js"

export type PullRequestCi = "passed" | "pending" | "failed" | "none"
export type PullRequestMergeability = "mergeable" | "conflicting" | "unknown"

export type PullRequestState =
  | Readonly<{ tag: "Open"; ci: PullRequestCi; mergeability: PullRequestMergeability }>
  | Readonly<{ tag: "Merged" }>
  | Readonly<{ tag: "Closed" }>

export type AvailablePullRequestStatus = Readonly<{
  tag: "Available"
  pullRequest: PullRequestUrl
  title: string
  state: PullRequestState
}> &
  (Readonly<{ stale: false }> | Readonly<{ stale: true; diagnostic: PullRequestDiagnostic }>)

export type PullRequestStatus =
  | AvailablePullRequestStatus
  | Readonly<{ tag: "Unavailable"; diagnostic?: PullRequestDiagnostic }>

export type GitHubUnavailable = Readonly<{
  tag: "GitHubUnavailable"
  message: "GitHub status unavailable"
  cause: unknown
}>

export type GitHubCliMissing = Readonly<{
  tag: "GitHubCliMissing"
  message: "GitHub CLI is not installed"
  cause: unknown
}>

export type GitHubAuthenticationRequired = Readonly<{
  tag: "GitHubAuthenticationRequired"
  message: "GitHub CLI authentication required"
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

export type GitHubBatchLimitExceeded = Readonly<{
  tag: "GitHubBatchLimitExceeded"
  limit: 20
  message: "GitHub batch cannot contain more than 20 pull requests"
}>

export type GitHubFailure =
  | GitHubCliMissing
  | GitHubAuthenticationRequired
  | GitHubUnavailable
  | GitHubCancelled
  | InvalidGitHubResponse
  | GitHubBatchLimitExceeded

export type GitHubBatch = readonly Result<AvailablePullRequestStatus, InvalidGitHubResponse>[]

export type PullRequestDiagnostic = Exclude<GitHubFailure, GitHubCancelled | GitHubBatchLimitExceeded>["tag"]

export type ProcessRunner = (
  file: string,
  args: readonly string[],
  options: Readonly<{ signal?: AbortSignal; cwd?: string }>,
) => Promise<Readonly<{ stdout: string }>>

export type GitHubClient = Readonly<{
  get(
    pullRequests: readonly PullRequestUrl[],
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<Result<GitHubBatch, GitHubFailure>>
}>

const invalidGitHubResponse: Result<never, InvalidGitHubResponse> = {
  ok: false,
  error: {
    tag: "InvalidGitHubResponse",
    message: "GitHub returned an invalid pull request response",
  },
}
const githubBatchLimitExceeded: Result<never, GitHubBatchLimitExceeded> = {
  ok: false,
  error: {
    tag: "GitHubBatchLimitExceeded",
    limit: 20,
    message: "GitHub batch cannot contain more than 20 pull requests",
  },
}

const checkRunPending = new Set(["QUEUED", "IN_PROGRESS", "WAITING", "PENDING"])
const checkRunPassed = new Set(["SUCCESS"])
const checkRunFailed = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"])
const checkRunIgnored = new Set(["NEUTRAL", "SKIPPED"])
const statusContextPending = new Set(["EXPECTED", "PENDING"])
const statusContextPassed = new Set(["SUCCESS"])
const statusContextFailed = new Set(["ERROR", "FAILURE"])
const maximumPullRequestsPerBatch = 20
const pullRequestSelection = `__typename ... on PullRequest { title state url mergedAt mergeable statusCheckRollup { contexts(first: 1) { checkRunCount statusContextCount checkRunCountsByState { state count } statusContextCountsByState { state count } } } }`

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

type CheckBucket = "passed" | "pending" | "failed" | "ignored"

type ProcessExecutionFailed = Readonly<{
  tag: "ProcessExecutionFailed"
  code: string | number | null
  stderr: string
  stdout: string
  cause: unknown
}>

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

function classifyCountState(
  state: string,
  states: Readonly<{
    passed: ReadonlySet<string>
    pending: ReadonlySet<string>
    failed: ReadonlySet<string>
    ignored?: ReadonlySet<string>
  }>,
): CheckBucket | undefined {
  if (states.failed.has(state)) return "failed"
  if (states.pending.has(state)) return "pending"
  if (states.passed.has(state)) return "passed"
  if (states.ignored?.has(state)) return "ignored"
  return undefined
}

function aggregateCounts(
  input: unknown,
  expectedTotal: unknown,
  states: Parameters<typeof classifyCountState>[1],
): Result<ReadonlySet<CheckBucket>, InvalidGitHubResponse> {
  if (!Array.isArray(input) || !Number.isInteger(expectedTotal) || Number(expectedTotal) < 0) {
    return invalidGitHubResponse
  }
  const buckets = new Set<CheckBucket>()
  const seenStates = new Set<string>()
  let total = 0
  for (const item of input) {
    if (
      !isRecord(item) ||
      typeof item.state !== "string" ||
      !Number.isInteger(item.count) ||
      Number(item.count) < 0 ||
      seenStates.has(item.state)
    ) {
      return invalidGitHubResponse
    }
    const bucket = classifyCountState(item.state, states)
    if (bucket === undefined && Number(item.count) > 0) return invalidGitHubResponse
    seenStates.add(item.state)
    total += Number(item.count)
    if (bucket !== undefined && Number(item.count) > 0) buckets.add(bucket)
  }
  return total === expectedTotal ? { ok: true, value: buckets } : invalidGitHubResponse
}

function parseStatusCheckRollup(input: unknown): Result<PullRequestCi, InvalidGitHubResponse> {
  if (input === null) return { ok: true, value: "none" }
  if (!isRecord(input) || !isRecord(input.contexts)) return invalidGitHubResponse
  const contexts = input.contexts
  const checkRuns = aggregateCounts(contexts.checkRunCountsByState, contexts.checkRunCount, {
    passed: checkRunPassed,
    pending: checkRunPending,
    failed: checkRunFailed,
    ignored: checkRunIgnored,
  })
  if (!checkRuns.ok) return checkRuns
  const statusContexts = aggregateCounts(contexts.statusContextCountsByState, contexts.statusContextCount, {
    passed: statusContextPassed,
    pending: statusContextPending,
    failed: statusContextFailed,
  })
  if (!statusContexts.ok) return statusContexts
  const buckets = new Set([...checkRuns.value, ...statusContexts.value])
  if (buckets.has("failed")) return { ok: true, value: "failed" }
  if (buckets.has("pending")) return { ok: true, value: "pending" }
  if (buckets.has("passed")) return { ok: true, value: "passed" }
  return { ok: true, value: "none" }
}

function samePullRequest(left: PullRequestUrl, right: PullRequestUrl): boolean {
  return (
    left.number === right.number &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repository.toLowerCase() === right.repository.toLowerCase()
  )
}

function parseMergeability(input: unknown): Result<PullRequestMergeability, InvalidGitHubResponse> {
  switch (input) {
    case "MERGEABLE":
      return { ok: true, value: "mergeable" }
    case "CONFLICTING":
      return { ok: true, value: "conflicting" }
    case "UNKNOWN":
      return { ok: true, value: "unknown" }
    default:
      return invalidGitHubResponse
  }
}

function parseResponse(
  input: unknown,
  pullRequest: PullRequestUrl,
): Result<AvailablePullRequestStatus, InvalidGitHubResponse> {
  if (
    !isRecord(input) ||
    input.__typename !== "PullRequest" ||
    typeof input.title !== "string" ||
    input.title.trim() === ""
  ) {
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

  const ci = parseStatusCheckRollup(input.statusCheckRollup)
  if (!ci.ok) return ci
  const mergeability = parseMergeability(input.mergeable)
  if (!mergeability.ok) return mergeability

  let state: PullRequestState
  switch (input.state) {
    case "OPEN":
      state = { tag: "Open", ci: ci.value, mergeability: mergeability.value }
      break
    case "MERGED":
      state = { tag: "Merged" }
      break
    case "CLOSED":
      state = { tag: "Closed" }
      break
    default:
      return casesHandled(input.state)
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

function createBatchQuery(size: number): string {
  const variables = Array.from({ length: size }, (_, index) => `$url${index}: URI!`).join(", ")
  const fields = Array.from(
    { length: size },
    (_, index) => `pr${index}: resource(url: $url${index}) { ${pullRequestSelection} }`,
  ).join(" ")
  return `query BatchPullRequests(${variables}) { ${fields} }`
}

function parseGraphqlErrorAliases(input: unknown, size: number): Result<ReadonlySet<number>, InvalidGitHubResponse> {
  if (input === undefined) return { ok: true, value: new Set() }
  if (!Array.isArray(input)) return invalidGitHubResponse
  const aliases = new Set<number>()
  for (const error of input) {
    if (
      !isRecord(error) ||
      typeof error.message !== "string" ||
      !Array.isArray(error.path) ||
      typeof error.path[0] !== "string"
    ) {
      return invalidGitHubResponse
    }
    const match = /^pr([0-9]+)$/.exec(error.path[0])
    if (match === null) return invalidGitHubResponse
    const index = Number(match[1])
    if (!Number.isInteger(index) || index < 0 || index >= size) return invalidGitHubResponse
    aliases.add(index)
  }
  return { ok: true, value: aliases }
}

function parseBatchResponse(
  input: unknown,
  pullRequests: readonly PullRequestUrl[],
): Result<GitHubBatch, InvalidGitHubResponse> {
  if (!isRecord(input) || !isRecord(input.data)) return invalidGitHubResponse
  const data = input.data
  const errorAliases = parseGraphqlErrorAliases(input.errors, pullRequests.length)
  if (!errorAliases.ok) return errorAliases
  return {
    ok: true,
    value: pullRequests.map((pullRequest, index) =>
      errorAliases.value.has(index) ? invalidGitHubResponse : parseResponse(data[`pr${index}`], pullRequest),
    ),
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

export function createGitHubClient(runner: ProcessRunner = execFileRunner): GitHubClient {
  return {
    async get(pullRequests, options = {}) {
      if (pullRequests.length === 0) return { ok: true, value: [] }
      if (pullRequests.length > maximumPullRequestsPerBatch) return githubBatchLimitExceeded
      const query = createBatchQuery(pullRequests.length)
      const args = ["api", "graphql", "--method", "POST", "-f", `query=${query}`]
      for (const [index, pullRequest] of pullRequests.entries()) {
        args.push("-f", `url${index}=${pullRequest.url}`)
      }
      let stdout: string
      let processFailure: GitHubCliMissing | GitHubAuthenticationRequired | GitHubUnavailable | undefined
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
        if (partialStdout !== undefined) {
          stdout = partialStdout
        } else {
          return { ok: false, error: processFailure }
        }
      }

      let decoded: unknown
      try {
        decoded = JSON.parse(stdout)
      } catch {
        return processFailure === undefined ? invalidGitHubResponse : { ok: false, error: processFailure }
      }
      const parsed = parseBatchResponse(decoded, pullRequests)
      if (processFailure === undefined || parsed.ok) return parsed
      return { ok: false, error: processFailure }
    },
  }
}

export type StatusAppearance = Readonly<{
  tone: "green" | "yellow" | "red" | "purple" | "gray"
  label: string
  strikethrough: boolean
}>

const openAppearances = {
  passed: { tone: "green", label: "checks passed", strikethrough: false },
  pending: { tone: "yellow", label: "checks pending", strikethrough: false },
  failed: { tone: "red", label: "checks failed", strikethrough: false },
  none: { tone: "gray", label: "no checks", strikethrough: false },
} satisfies Record<PullRequestCi, StatusAppearance>

const diagnosticLabels = {
  GitHubCliMissing: "install gh",
  GitHubAuthenticationRequired: "run gh auth login",
  GitHubUnavailable: "GitHub unavailable",
  InvalidGitHubResponse: "invalid GitHub response",
} satisfies Record<PullRequestDiagnostic, string>

function stateAppearance(state: PullRequestState): StatusAppearance {
  switch (state.tag) {
    case "Open": {
      switch (state.mergeability) {
        case "conflicting":
          return { tone: "red", label: "merge conflict", strikethrough: false }
        case "mergeable":
        case "unknown":
          return openAppearances[state.ci]
        default:
          return casesHandled(state.mergeability)
      }
    }
    case "Merged":
      return { tone: "purple", label: "merged", strikethrough: true }
    case "Closed":
      return { tone: "red", label: "closed", strikethrough: true }
    default:
      return casesHandled(state)
  }
}

export function statusAppearance(status: PullRequestStatus): StatusAppearance {
  if (status.tag === "Unavailable") {
    return {
      tone: "gray",
      label: status.diagnostic === undefined ? "status unavailable" : diagnosticLabels[status.diagnostic],
      strikethrough: false,
    }
  }

  const appearance = stateAppearance(status.state)
  return status.stale
    ? { ...appearance, label: `${appearance.label} (stale; ${diagnosticLabels[status.diagnostic]})` }
    : appearance
}
