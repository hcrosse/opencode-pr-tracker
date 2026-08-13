import { casesHandled } from "./exhaustive.js"
import {
  type AvailablePullRequestStatus,
  type GitHubBatchLimitExceeded,
  type GitHubCancelled,
  type GitHubClient,
  type InvalidGitHubResponse,
  type PullRequestBlocker,
  type PullRequestCi,
  type PullRequestDiagnostic,
  type PullRequestItemFailure,
  type PullRequestMergeability,
  type PullRequestNotFound,
  type PullRequestState,
  type PullRequestStatus,
} from "./github-types.js"
import { execFileRunner, runAndDecode, type ProcessRunner } from "./github-transport.js"
import { parsePullRequestUrl, type PullRequestUrl, type Result } from "./url.js"

export type {
  AvailablePullRequestStatus,
  GitHubAuthenticationRequired,
  GitHubBatch,
  GitHubBatchLimitExceeded,
  GitHubCancelled,
  GitHubCliMissing,
  GitHubClient,
  GitHubFailure,
  GitHubUnavailable,
  InvalidGitHubResponse,
  PullRequestBlocker,
  PullRequestCi,
  PullRequestDiagnostic,
  PullRequestItemFailure,
  PullRequestMergeability,
  PullRequestNotFound,
  PullRequestState,
  PullRequestStatus,
} from "./github-types.js"
export { execFileRunner } from "./github-transport.js"
export type { ProcessRunner } from "./github-transport.js"

const invalidGitHubResponse: Result<never, InvalidGitHubResponse> = {
  ok: false,
  error: {
    tag: "InvalidGitHubResponse",
    message: "GitHub returned an invalid pull request response",
  },
}
const pullRequestNotFound: Result<never, PullRequestNotFound> = {
  ok: false,
  error: {
    tag: "PullRequestNotFound",
    message: "Pull request does not exist or is not accessible",
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

const maximumPullRequestsPerBatch = 20
const maximumCheckContextsPerPage = 100
const maximumStackEntriesPerPage = 100
const statusContextOnlyFields = ["context", "state", "createdAt"] as const
const checkRunOnlyFields = ["name", "status", "conclusion", "checkSuite"] as const
const checkContextSelection = `nodes { __typename ... on StatusContext { id context state createdAt } ... on CheckRun { id name status conclusion checkSuite { id createdAt app { id } workflowRun { event runNumber runAttempt workflow { id } } } } } totalCount pageInfo { hasNextPage endCursor }`
const pullRequestSelection = `__typename ... on PullRequest { title state url mergedAt mergeable mergeStateStatus baseRef { branchProtectionRule { requiresStatusChecks requiresStrictStatusChecks } refUpdateRule { requiredStatusCheckContexts } rules(first: 100) { nodes { parameters { __typename ... on RequiredStatusChecksParameters { strictRequiredStatusChecksPolicy requiredStatusChecks { context } } } } totalCount pageInfo { hasNextPage } } } statusCheckRollup { contexts(first: ${maximumCheckContextsPerPage}) { ${checkContextSelection} } } }`
const continuationQuery = `query PullRequestContexts($url: URI!, $cursor: String!) { resource(url: $url) { __typename ... on PullRequest { url statusCheckRollup { contexts(first: ${maximumCheckContextsPerPage}, after: $cursor) { ${checkContextSelection} } } } } }`
const stackEntrySelection = `nodes { position pullRequest { url } } totalCount pageInfo { hasNextPage endCursor }`
const stackQuery = `query PullRequestStack($url: URI!) { resource(url: $url) { __typename ... on PullRequest { url stack { id size entries(first: ${maximumStackEntriesPerPage}) { ${stackEntrySelection} } } } } }`
const stackContinuationQuery = `query PullRequestStackEntries($url: URI!, $cursor: String!) { resource(url: $url) { __typename ... on PullRequest { url stack { id size entries(first: ${maximumStackEntriesPerPage}, after: $cursor) { ${stackEntrySelection} } } } } }`

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

type CheckBucket = "passed" | "pending" | "failed" | "ignored"

type StatusContextState = "EXPECTED" | "PENDING" | "SUCCESS" | "ERROR" | "FAILURE"
type CheckRunStatus = "REQUESTED" | "QUEUED" | "IN_PROGRESS" | "COMPLETED" | "WAITING" | "PENDING"
type CheckRunConclusion =
  | "SUCCESS"
  | "FAILURE"
  | "CANCELLED"
  | "TIMED_OUT"
  | "ACTION_REQUIRED"
  | "STARTUP_FAILURE"
  | "STALE"
  | "NEUTRAL"
  | "SKIPPED"

type ParsedTimestamp = Readonly<{
  epochSeconds: number
  fractionalSeconds: string
}>

type ParsedStatusContext = Readonly<{
  tag: "StatusContext"
  id: string
  context: string
  state: StatusContextState
  createdAt: ParsedTimestamp
}>

type ParsedCheckRun = Readonly<{
  tag: "CheckRun"
  id: string
  name: string
  status: CheckRunStatus
  conclusion: CheckRunConclusion | null
  suiteId: string
  suiteCreatedAt: ParsedTimestamp
  sourceIdentity: readonly ["app" | "suite", string]
  workflowRun:
    | Readonly<{
        event: string
        runNumber: number
        runAttempt: number
        workflowId: string
      }>
    | undefined
}>

type ParsedCheckContext = ParsedStatusContext | ParsedCheckRun

type ParsedCheckContextPage = Readonly<{
  contexts: readonly ParsedCheckContext[]
  totalCount: number
  nextCursor?: string
}>

function parseNonBlankString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() !== "" ? input : undefined
}

function parseDate(input: unknown): ParsedTimestamp | undefined {
  if (typeof input !== "string") return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(
    input,
  )
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = Number(match[8] ?? 0)
  const offsetMinute = Number(match[9] ?? 0)
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return undefined
  }
  if (Number.isNaN(new Date(input).valueOf())) return undefined
  const epochSeconds = new Date(input.replace(/\.\d+/, "")).valueOf() / 1000
  if (!Number.isInteger(epochSeconds)) return undefined
  return {
    epochSeconds,
    fractionalSeconds: (match[7] ?? "").replace(/0+$/, ""),
  }
}

function compareTimestamps(left: ParsedTimestamp, right: ParsedTimestamp): -1 | 0 | 1 {
  if (left.epochSeconds < right.epochSeconds) return -1
  if (left.epochSeconds > right.epochSeconds) return 1
  const width = Math.max(left.fractionalSeconds.length, right.fractionalSeconds.length)
  const leftFraction = left.fractionalSeconds.padEnd(width, "0")
  const rightFraction = right.fractionalSeconds.padEnd(width, "0")
  if (leftFraction < rightFraction) return -1
  if (leftFraction > rightFraction) return 1
  return 0
}

function parseStatusContextState(input: unknown): StatusContextState | undefined {
  switch (input) {
    case "EXPECTED":
    case "PENDING":
    case "SUCCESS":
    case "ERROR":
    case "FAILURE":
      return input
    default:
      return undefined
  }
}

function parseCheckRunStatus(input: unknown): CheckRunStatus | undefined {
  switch (input) {
    case "REQUESTED":
    case "QUEUED":
    case "IN_PROGRESS":
    case "COMPLETED":
    case "WAITING":
    case "PENDING":
      return input
    default:
      return undefined
  }
}

function parseCheckRunConclusion(input: unknown): CheckRunConclusion | null | undefined {
  switch (input) {
    case null:
    case "SUCCESS":
    case "FAILURE":
    case "CANCELLED":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
    case "STALE":
    case "NEUTRAL":
    case "SKIPPED":
      return input
    default:
      return undefined
  }
}

function parseStatusContext(input: Record<string, unknown>): Result<ParsedStatusContext, InvalidGitHubResponse> {
  const id = parseNonBlankString(input.id)
  const context = parseNonBlankString(input.context)
  const state = parseStatusContextState(input.state)
  const createdAt = parseDate(input.createdAt)
  if (id === undefined || context === undefined || state === undefined || createdAt === undefined) {
    return invalidGitHubResponse
  }
  return { ok: true, value: { tag: "StatusContext", id, context, state, createdAt } }
}

function parseCheckRun(input: Record<string, unknown>): Result<ParsedCheckRun, InvalidGitHubResponse> {
  const id = parseNonBlankString(input.id)
  const name = parseNonBlankString(input.name)
  const status = parseCheckRunStatus(input.status)
  const conclusion = parseCheckRunConclusion(input.conclusion)
  if (
    id === undefined ||
    name === undefined ||
    status === undefined ||
    conclusion === undefined ||
    (status !== "COMPLETED" && conclusion !== null) ||
    !isRecord(input.checkSuite)
  ) {
    return invalidGitHubResponse
  }

  const suiteId = parseNonBlankString(input.checkSuite.id)
  const suiteCreatedAt = parseDate(input.checkSuite.createdAt)
  if (suiteId === undefined || suiteCreatedAt === undefined) return invalidGitHubResponse

  let sourceIdentity: readonly ["app" | "suite", string]
  if (input.checkSuite.app === null) {
    sourceIdentity = ["suite", suiteId]
  } else {
    if (!isRecord(input.checkSuite.app)) return invalidGitHubResponse
    const appId = parseNonBlankString(input.checkSuite.app.id)
    if (appId === undefined) return invalidGitHubResponse
    sourceIdentity = ["app", appId]
  }

  let workflowRun: ParsedCheckRun["workflowRun"]
  if (input.checkSuite.workflowRun === null) {
    workflowRun = undefined
  } else {
    if (!isRecord(input.checkSuite.workflowRun) || !isRecord(input.checkSuite.workflowRun.workflow)) {
      return invalidGitHubResponse
    }
    const event = parseNonBlankString(input.checkSuite.workflowRun.event)
    const workflowId = parseNonBlankString(input.checkSuite.workflowRun.workflow.id)
    const runNumber = input.checkSuite.workflowRun.runNumber
    const runAttempt = input.checkSuite.workflowRun.runAttempt
    if (
      event === undefined ||
      workflowId === undefined ||
      !Number.isInteger(runNumber) ||
      Number(runNumber) <= 0 ||
      !Number.isInteger(runAttempt) ||
      Number(runAttempt) <= 0
    ) {
      return invalidGitHubResponse
    }
    workflowRun = { event, workflowId, runNumber: Number(runNumber), runAttempt: Number(runAttempt) }
  }

  return {
    ok: true,
    value: { tag: "CheckRun", id, name, status, conclusion, suiteId, suiteCreatedAt, sourceIdentity, workflowRun },
  }
}

function parseCheckContexts(input: unknown): Result<ParsedCheckContextPage, InvalidGitHubResponse> {
  if (
    !isRecord(input) ||
    !Number.isInteger(input.totalCount) ||
    Number(input.totalCount) < 0 ||
    !isRecord(input.pageInfo) ||
    typeof input.pageInfo.hasNextPage !== "boolean" ||
    (input.pageInfo.endCursor !== null && typeof input.pageInfo.endCursor !== "string")
  ) {
    return invalidGitHubResponse
  }

  const nodes = input.nodes === null && input.totalCount === 0 ? [] : input.nodes
  if (!Array.isArray(nodes) || nodes.length > maximumCheckContextsPerPage || nodes.length > Number(input.totalCount)) {
    return invalidGitHubResponse
  }

  const contexts: ParsedCheckContext[] = []
  const ids = new Set<string>()
  for (const node of nodes) {
    if (!isRecord(node)) return invalidGitHubResponse
    let parsed: Result<ParsedCheckContext, InvalidGitHubResponse>
    switch (node.__typename) {
      case "StatusContext":
        if (checkRunOnlyFields.some((field) => field in node)) return invalidGitHubResponse
        parsed = parseStatusContext(node)
        break
      case "CheckRun":
        if (statusContextOnlyFields.some((field) => field in node)) return invalidGitHubResponse
        parsed = parseCheckRun(node)
        break
      default:
        return invalidGitHubResponse
    }
    if (!parsed.ok || ids.has(parsed.value.id)) return invalidGitHubResponse
    ids.add(parsed.value.id)
    contexts.push(parsed.value)
  }
  const nextCursor = input.pageInfo.hasNextPage ? parseNonBlankString(input.pageInfo.endCursor) : undefined
  if (input.pageInfo.hasNextPage && nextCursor === undefined) return invalidGitHubResponse
  if (nextCursor !== undefined && contexts.length === 0) return invalidGitHubResponse
  return {
    ok: true,
    value: {
      contexts,
      totalCount: Number(input.totalCount),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
  }
}

function classifyStatusContext(state: StatusContextState): Exclude<CheckBucket, "ignored"> {
  switch (state) {
    case "ERROR":
    case "FAILURE":
      return "failed"
    case "EXPECTED":
    case "PENDING":
      return "pending"
    case "SUCCESS":
      return "passed"
    default:
      return casesHandled(state)
  }
}

function classifyCheckRun(checkRun: ParsedCheckRun): CheckBucket {
  if (checkRun.status !== "COMPLETED") return "pending"
  switch (checkRun.conclusion) {
    case "FAILURE":
    case "CANCELLED":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
    case "STALE":
      return "failed"
    case "SUCCESS":
      return "passed"
    case "NEUTRAL":
    case "SKIPPED":
    case null:
      return "ignored"
    default:
      return casesHandled(checkRun.conclusion)
  }
}

function classifyContexts(contexts: readonly ParsedCheckContext[]): PullRequestCi {
  const statusContexts = new Map<string, { createdAt: ParsedTimestamp; buckets: CheckBucket[] }>()
  const workflowChecks = new Map<string, { runNumber: number; runAttempt: number; buckets: CheckBucket[] }>()
  const nonWorkflowChecks = new Map<string, { suiteCreatedAt: ParsedTimestamp; buckets: CheckBucket[] }>()

  for (const context of contexts) {
    if (context.tag === "StatusContext") {
      const identity = context.context.toLowerCase()
      const existing = statusContexts.get(identity)
      const bucket = classifyStatusContext(context.state)
      const ordering = existing === undefined ? 1 : compareTimestamps(context.createdAt, existing.createdAt)
      if (ordering > 0) {
        statusContexts.set(identity, { createdAt: context.createdAt, buckets: [bucket] })
      } else if (ordering === 0 && existing !== undefined) {
        existing.buckets.push(bucket)
      }
      continue
    }

    const bucket = classifyCheckRun(context)
    if (context.workflowRun !== undefined) {
      const identity = JSON.stringify([
        "workflow",
        context.sourceIdentity,
        context.workflowRun.workflowId,
        context.workflowRun.event,
        context.name,
      ])
      const existing = workflowChecks.get(identity)
      const isNewer =
        existing === undefined ||
        context.workflowRun.runNumber > existing.runNumber ||
        (context.workflowRun.runNumber === existing.runNumber && context.workflowRun.runAttempt > existing.runAttempt)
      if (isNewer) {
        workflowChecks.set(identity, {
          runNumber: context.workflowRun.runNumber,
          runAttempt: context.workflowRun.runAttempt,
          buckets: [bucket],
        })
      } else if (
        context.workflowRun.runNumber === existing.runNumber &&
        context.workflowRun.runAttempt === existing.runAttempt
      ) {
        existing.buckets.push(bucket)
      }
      continue
    }

    const identity = JSON.stringify(["check", context.sourceIdentity, context.name])
    const existing = nonWorkflowChecks.get(identity)
    const ordering = existing === undefined ? 1 : compareTimestamps(context.suiteCreatedAt, existing.suiteCreatedAt)
    if (ordering > 0) {
      nonWorkflowChecks.set(identity, { suiteCreatedAt: context.suiteCreatedAt, buckets: [bucket] })
    } else if (ordering === 0 && existing !== undefined) {
      existing.buckets.push(bucket)
    }
  }

  const buckets = new Set<CheckBucket>()
  for (const selection of [...statusContexts.values(), ...workflowChecks.values(), ...nonWorkflowChecks.values()]) {
    for (const bucket of selection.buckets) buckets.add(bucket)
  }
  if (buckets.has("failed")) return "failed"
  if (buckets.has("pending")) return "pending"
  if (buckets.has("passed")) return "passed"
  return "none"
}

function parseStatusCheckRollup(input: unknown): Result<ParsedCheckContextPage | null, InvalidGitHubResponse> {
  if (input === null) return { ok: true, value: null }
  if (!isRecord(input)) return invalidGitHubResponse
  return parseCheckContexts(input.contexts)
}

function samePullRequest(left: PullRequestUrl, right: PullRequestUrl): boolean {
  return (
    left.number === right.number &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repository.toLowerCase() === right.repository.toLowerCase()
  )
}

function sameRepository(left: PullRequestUrl, right: PullRequestUrl): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repository.toLowerCase() === right.repository.toLowerCase()
  )
}

type ParsedStackEntry = Readonly<{ position: number; pullRequest: PullRequestUrl }>
type ParsedStackPage = Readonly<{
  stackId: string
  size: number
  entries: readonly ParsedStackEntry[]
  totalCount: number
  nextCursor?: string
}>

function parseStackResponse(
  input: unknown,
  requested: PullRequestUrl,
): Result<ParsedStackPage | null, PullRequestNotFound | InvalidGitHubResponse> {
  if (
    !isRecord(input) ||
    (input.errors !== undefined && (!Array.isArray(input.errors) || input.errors.length > 0)) ||
    !isRecord(input.data)
  ) {
    return invalidGitHubResponse
  }
  if (input.data.resource === null) return pullRequestNotFound
  if (!isRecord(input.data.resource)) return invalidGitHubResponse

  const resource = input.data.resource
  if (resource.__typename !== "PullRequest" || typeof resource.url !== "string") return invalidGitHubResponse
  const resourceUrl = parsePullRequestUrl(resource.url)
  if (!resourceUrl.ok || !samePullRequest(resourceUrl.value, requested)) return invalidGitHubResponse
  if (resource.stack === null) return { ok: true, value: null }
  if (!isRecord(resource.stack)) return invalidGitHubResponse

  const id = parseNonBlankString(resource.stack.id)
  const size = resource.stack.size
  if (id === undefined || !Number.isSafeInteger(size) || Number(size) <= 0 || !isRecord(resource.stack.entries)) {
    return invalidGitHubResponse
  }

  const entries = resource.stack.entries
  if (
    !Number.isSafeInteger(entries.totalCount) ||
    Number(entries.totalCount) <= 0 ||
    !isRecord(entries.pageInfo) ||
    typeof entries.pageInfo.hasNextPage !== "boolean" ||
    (entries.pageInfo.endCursor !== null && typeof entries.pageInfo.endCursor !== "string") ||
    (entries.pageInfo.hasNextPage && parseNonBlankString(entries.pageInfo.endCursor) === undefined) ||
    !Array.isArray(entries.nodes) ||
    entries.nodes.length === 0 ||
    entries.nodes.length > maximumStackEntriesPerPage ||
    entries.nodes.length > Number(size) ||
    (entries.pageInfo.hasNextPage && entries.nodes.length >= Number(size))
  ) {
    return invalidGitHubResponse
  }

  const parsedEntries: ParsedStackEntry[] = []
  for (const entry of entries.nodes) {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.position) ||
      Number(entry.position) <= 0 ||
      Number(entry.position) > Number(size) ||
      !isRecord(entry.pullRequest) ||
      typeof entry.pullRequest.url !== "string"
    ) {
      return invalidGitHubResponse
    }
    const parsedUrl = parsePullRequestUrl(entry.pullRequest.url)
    if (!parsedUrl.ok || !sameRepository(parsedUrl.value, requested)) return invalidGitHubResponse
    const position = Number(entry.position)
    parsedEntries.push({ position, pullRequest: parsedUrl.value })
  }
  const nextCursor = entries.pageInfo.hasNextPage ? parseNonBlankString(entries.pageInfo.endCursor) : undefined
  return {
    ok: true,
    value: {
      stackId: id,
      size: Number(size),
      entries: parsedEntries,
      totalCount: Number(entries.totalCount),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
  }
}

function parseStackContinuationResponse(
  input: unknown,
  requested: PullRequestUrl,
): Result<ParsedStackPage, PullRequestNotFound | InvalidGitHubResponse> {
  const parsed = parseStackResponse(input, requested)
  if (!parsed.ok) return parsed
  return parsed.value === null ? invalidGitHubResponse : { ok: true, value: parsed.value }
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

function parseMergeStateStatus(input: unknown): Result<"behind" | "other", InvalidGitHubResponse> {
  switch (input) {
    case "BEHIND":
      return { ok: true, value: "behind" }
    case "BLOCKED":
    case "CLEAN":
    case "DIRTY":
    case "DRAFT":
    case "HAS_HOOKS":
    case "UNKNOWN":
    case "UNSTABLE":
      return { ok: true, value: "other" }
    default:
      return invalidGitHubResponse
  }
}

function parseRequiredStatusChecks(input: unknown): Result<boolean, InvalidGitHubResponse> {
  if (!Array.isArray(input)) return invalidGitHubResponse
  for (const check of input) {
    if (!isRecord(check) || typeof check.context !== "string" || check.context.trim() === "") {
      return invalidGitHubResponse
    }
  }
  return { ok: true, value: input.length > 0 }
}

function parseRules(input: unknown): Result<Readonly<{ strict: boolean; incomplete: boolean }>, InvalidGitHubResponse> {
  if (
    !isRecord(input) ||
    !Number.isInteger(input.totalCount) ||
    Number(input.totalCount) < 0 ||
    !isRecord(input.pageInfo) ||
    typeof input.pageInfo.hasNextPage !== "boolean"
  ) {
    return invalidGitHubResponse
  }

  const nodes = input.nodes === null && input.totalCount === 0 ? [] : input.nodes
  if (!Array.isArray(nodes) || nodes.length > Number(input.totalCount)) return invalidGitHubResponse
  if (input.pageInfo.hasNextPage ? nodes.length >= Number(input.totalCount) : nodes.length !== input.totalCount) {
    return invalidGitHubResponse
  }

  let strict = false
  for (const node of nodes) {
    if (!isRecord(node) || !(node.parameters === null || isRecord(node.parameters))) {
      return invalidGitHubResponse
    }
    if (node.parameters === null) continue
    if (typeof node.parameters.__typename !== "string") return invalidGitHubResponse
    if (node.parameters.__typename !== "RequiredStatusChecksParameters") continue
    if (typeof node.parameters.strictRequiredStatusChecksPolicy !== "boolean") return invalidGitHubResponse
    const requiredChecks = parseRequiredStatusChecks(node.parameters.requiredStatusChecks)
    if (!requiredChecks.ok) return requiredChecks
    if (node.parameters.strictRequiredStatusChecksPolicy && requiredChecks.value) strict = true
  }

  return { ok: true, value: { strict, incomplete: input.pageInfo.hasNextPage } }
}

function parseRefUpdateRule(input: unknown): Result<boolean, InvalidGitHubResponse> {
  if (input === null) return { ok: true, value: false }
  if (!isRecord(input)) return invalidGitHubResponse
  if (input.requiredStatusCheckContexts === null) return { ok: true, value: false }
  if (!Array.isArray(input.requiredStatusCheckContexts)) return invalidGitHubResponse
  for (const context of input.requiredStatusCheckContexts) {
    if (typeof context !== "string" || context.trim() === "") return invalidGitHubResponse
  }
  return { ok: true, value: input.requiredStatusCheckContexts.length > 0 }
}

function parseUpdatePolicy(
  input: unknown,
): Result<Readonly<{ strict: boolean; incomplete: boolean }>, InvalidGitHubResponse> {
  if (input === null) return { ok: true, value: { strict: false, incomplete: false } }
  if (!isRecord(input)) return invalidGitHubResponse

  const refUpdateHasRequiredChecks = parseRefUpdateRule(input.refUpdateRule)
  if (!refUpdateHasRequiredChecks.ok) return refUpdateHasRequiredChecks

  let branchProtectionIsStrict = false
  if (input.branchProtectionRule !== null) {
    if (
      !isRecord(input.branchProtectionRule) ||
      typeof input.branchProtectionRule.requiresStatusChecks !== "boolean" ||
      typeof input.branchProtectionRule.requiresStrictStatusChecks !== "boolean"
    ) {
      return invalidGitHubResponse
    }
    branchProtectionIsStrict =
      input.branchProtectionRule.requiresStatusChecks && input.branchProtectionRule.requiresStrictStatusChecks
  }

  const rules = parseRules(input.rules)
  if (!rules.ok) return rules
  return {
    ok: true,
    value: {
      strict: branchProtectionIsStrict || rules.value.strict,
      incomplete: rules.value.incomplete || (input.branchProtectionRule === null && refUpdateHasRequiredChecks.value),
    },
  }
}

function parseBlocker(
  mergeStateStatusInput: unknown,
  baseRefInput: unknown,
): Result<PullRequestBlocker, InvalidGitHubResponse> {
  const mergeStateStatus = parseMergeStateStatus(mergeStateStatusInput)
  if (!mergeStateStatus.ok) return mergeStateStatus
  if (mergeStateStatus.value !== "behind") return { ok: true, value: "none" }
  const updatePolicy = parseUpdatePolicy(baseRefInput)
  if (!updatePolicy.ok) return updatePolicy
  if (updatePolicy.value.strict) return { ok: true, value: "behind" }
  return updatePolicy.value.incomplete ? invalidGitHubResponse : { ok: true, value: "none" }
}

type ParsedPullRequestMetadata = Readonly<{
  title: string
  state: "OPEN" | "CLOSED" | "MERGED"
  mergeability: PullRequestMergeability
  mergeStateStatus: unknown
  baseRef: unknown
}>

function parsePullRequestMetadata(
  input: unknown,
  pullRequest: PullRequestUrl,
): Result<ParsedPullRequestMetadata, InvalidGitHubResponse> {
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

  const mergeability = parseMergeability(input.mergeable)
  if (!mergeability.ok) return mergeability

  return {
    ok: true,
    value: {
      title: input.title,
      state: input.state,
      mergeability: mergeability.value,
      mergeStateStatus: input.mergeStateStatus,
      baseRef: input.baseRef,
    },
  }
}

function finalizeResponse(
  metadata: ParsedPullRequestMetadata,
  pullRequest: PullRequestUrl,
  ci: PullRequestCi,
): Result<AvailablePullRequestStatus, InvalidGitHubResponse> {
  let state: PullRequestState
  switch (metadata.state) {
    case "OPEN": {
      let blocker: PullRequestBlocker = "none"
      if (metadata.mergeability !== "conflicting" && (ci === "none" || ci === "passed")) {
        const parsedBlocker = parseBlocker(metadata.mergeStateStatus, metadata.baseRef)
        if (!parsedBlocker.ok) return parsedBlocker
        blocker = parsedBlocker.value
      }
      state = { tag: "Open", ci, mergeability: metadata.mergeability, blocker }
      break
    }
    case "MERGED":
      state = { tag: "Merged" }
      break
    case "CLOSED":
      state = { tag: "Closed" }
      break
    default:
      return casesHandled(metadata.state)
  }

  return {
    ok: true,
    value: {
      tag: "Available",
      pullRequest,
      title: metadata.title,
      state,
      stale: false,
    },
  }
}

type ParsedInitialPullRequest = Readonly<{
  pullRequest: PullRequestUrl
  metadata: ParsedPullRequestMetadata
  contextPage: ParsedCheckContextPage | null
}>

function parseInitialPullRequest(
  input: unknown,
  pullRequest: PullRequestUrl,
): Result<ParsedInitialPullRequest, PullRequestNotFound | InvalidGitHubResponse> {
  if (input === null) return pullRequestNotFound
  if (!isRecord(input)) return invalidGitHubResponse
  const contextPage = parseStatusCheckRollup(input.statusCheckRollup)
  if (!contextPage.ok) return contextPage
  if (
    contextPage.value !== null &&
    contextPage.value.nextCursor === undefined &&
    contextPage.value.contexts.length !== contextPage.value.totalCount
  ) {
    return invalidGitHubResponse
  }
  const metadata = parsePullRequestMetadata(input, pullRequest)
  return metadata.ok
    ? { ok: true, value: { pullRequest, metadata: metadata.value, contextPage: contextPage.value } }
    : metadata
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
): Result<
  readonly Result<ParsedInitialPullRequest, PullRequestNotFound | InvalidGitHubResponse>[],
  InvalidGitHubResponse
> {
  if (!isRecord(input) || !isRecord(input.data)) return invalidGitHubResponse
  const data = input.data
  const errorAliases = parseGraphqlErrorAliases(input.errors, pullRequests.length)
  if (!errorAliases.ok) return errorAliases
  return {
    ok: true,
    value: pullRequests.map((pullRequest, index) =>
      errorAliases.value.has(index) ? invalidGitHubResponse : parseInitialPullRequest(data[`pr${index}`], pullRequest),
    ),
  }
}

function parseContinuationResponse(
  input: unknown,
  pullRequest: PullRequestUrl,
): Result<ParsedCheckContextPage, InvalidGitHubResponse> {
  if (
    !isRecord(input) ||
    (input.errors !== undefined && (!Array.isArray(input.errors) || input.errors.length > 0)) ||
    !isRecord(input.data) ||
    !isRecord(input.data.resource)
  ) {
    return invalidGitHubResponse
  }
  const resource = input.data.resource
  if (resource.__typename !== "PullRequest" || typeof resource.url !== "string") return invalidGitHubResponse
  const responseUrl = parsePullRequestUrl(resource.url)
  if (!responseUrl.ok || !samePullRequest(responseUrl.value, pullRequest) || !isRecord(resource.statusCheckRollup)) {
    return invalidGitHubResponse
  }
  return parseCheckContexts(resource.statusCheckRollup.contexts)
}

type ContinuationOutcome =
  | Readonly<{ tag: "Item"; result: Result<AvailablePullRequestStatus, PullRequestItemFailure> }>
  | Readonly<{ tag: "Cancelled"; error: GitHubCancelled }>

async function continuePullRequest(
  runner: ProcessRunner,
  initial: ParsedInitialPullRequest,
  options: Readonly<{ signal?: AbortSignal }>,
): Promise<ContinuationOutcome> {
  if (initial.contextPage?.nextCursor === undefined) {
    const ci = initial.contextPage === null ? "none" : classifyContexts(initial.contextPage.contexts)
    return { tag: "Item", result: finalizeResponse(initial.metadata, initial.pullRequest, ci) }
  }

  const contexts = [...initial.contextPage.contexts]
  const totalCount = initial.contextPage.totalCount
  const contextIds = new Set(contexts.map((context) => context.id))
  const cursors = new Set([initial.contextPage.nextCursor])
  let cursor: string | undefined = initial.contextPage.nextCursor
  while (cursor !== undefined) {
    const args = [
      "api",
      "graphql",
      "--method",
      "POST",
      "-f",
      `query=${continuationQuery}`,
      "-f",
      `url=${initial.pullRequest.url}`,
      "-f",
      `cursor=${cursor}`,
    ]
    const output = await runAndDecode(runner, args, options)
    if (!output.ok) {
      return output.error.tag === "GitHubCancelled"
        ? { tag: "Cancelled", error: output.error }
        : { tag: "Item", result: { ok: false, error: output.error } }
    }
    const page = parseContinuationResponse(output.value.decoded, initial.pullRequest)
    if (!page.ok) {
      return {
        tag: "Item",
        result: { ok: false, error: output.value.processFailure ?? page.error },
      }
    }
    if (page.value.totalCount !== totalCount) return { tag: "Item", result: invalidGitHubResponse }
    for (const context of page.value.contexts) {
      if (contextIds.has(context.id)) return { tag: "Item", result: invalidGitHubResponse }
      contextIds.add(context.id)
    }
    if (contexts.length + page.value.contexts.length > totalCount) {
      return { tag: "Item", result: invalidGitHubResponse }
    }
    if (page.value.nextCursor !== undefined) {
      if (cursors.has(page.value.nextCursor)) return { tag: "Item", result: invalidGitHubResponse }
      cursors.add(page.value.nextCursor)
    }
    contexts.push(...page.value.contexts)
    cursor = page.value.nextCursor
  }

  if (contexts.length !== totalCount) return { tag: "Item", result: invalidGitHubResponse }

  const status = finalizeResponse(initial.metadata, initial.pullRequest, classifyContexts(contexts))
  return { tag: "Item", result: status }
}

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
      const output = await runAndDecode(runner, args, options)
      if (!output.ok) return output
      const parsed = parseBatchResponse(output.value.decoded, pullRequests)
      if (!parsed.ok) return { ok: false, error: output.value.processFailure ?? parsed.error }

      const outcomes = await Promise.all(
        parsed.value.map((item): Promise<ContinuationOutcome> => {
          if (!item.ok) return Promise.resolve({ tag: "Item", result: item })
          return continuePullRequest(runner, item.value, options)
        }),
      )
      const batch: Result<AvailablePullRequestStatus, PullRequestItemFailure>[] = []
      let cancellation: GitHubCancelled | undefined
      for (const outcome of outcomes) {
        if (outcome.tag === "Cancelled") cancellation ??= outcome.error
        else batch.push(outcome.result)
      }
      return cancellation === undefined ? { ok: true, value: batch } : { ok: false, error: cancellation }
    },
    async getStack(pullRequest, options = {}) {
      const args = ["api", "graphql", "--method", "POST", "-f", `query=${stackQuery}`, "-f", `url=${pullRequest.url}`]
      const output = await runAndDecode(runner, args, options)
      if (!output.ok) return output
      const parsed = parseStackResponse(output.value.decoded, pullRequest)
      if (!parsed.ok) return { ok: false, error: output.value.processFailure ?? parsed.error }
      if (parsed.value === null) return { ok: true, value: [pullRequest] }

      const stackId = parsed.value.stackId
      const size = parsed.value.size
      const entries: ParsedStackEntry[] = []
      const seenCursors = new Set<string>()
      const seenPositions = new Set<number>()
      const seenUrls = new Set<string>()
      let includesRequested = false
      let page = parsed.value
      while (true) {
        if (page.stackId !== stackId || page.size !== size || page.totalCount !== size) {
          return invalidGitHubResponse
        }
        if (entries.length + page.entries.length > size) return invalidGitHubResponse
        for (const entry of page.entries) {
          if (seenPositions.has(entry.position) || seenUrls.has(entry.pullRequest.url)) {
            return invalidGitHubResponse
          }
          seenPositions.add(entry.position)
          seenUrls.add(entry.pullRequest.url)
          if (samePullRequest(entry.pullRequest, pullRequest)) includesRequested = true
          entries.push(entry)
        }

        const nextCursor = page.nextCursor
        if (nextCursor === undefined) break
        if (seenCursors.has(nextCursor)) return invalidGitHubResponse
        seenCursors.add(nextCursor)

        const continuationArgs = [
          "api",
          "graphql",
          "--method",
          "POST",
          "-f",
          `query=${stackContinuationQuery}`,
          "-f",
          `url=${pullRequest.url}`,
          "-f",
          `cursor=${nextCursor}`,
        ]
        const continuationOutput = await runAndDecode(runner, continuationArgs, options)
        if (!continuationOutput.ok) return continuationOutput
        const continuation = parseStackContinuationResponse(continuationOutput.value.decoded, pullRequest)
        if (!continuation.ok) {
          return { ok: false, error: continuationOutput.value.processFailure ?? continuation.error }
        }
        page = continuation.value
      }

      if (entries.length !== size || !includesRequested) return invalidGitHubResponse
      for (let position = 1; position <= size; position += 1) {
        if (!seenPositions.has(position)) return invalidGitHubResponse
      }
      entries.sort((left, right) => left.position - right.position)
      const first = entries[0]
      if (first === undefined) return invalidGitHubResponse
      return {
        ok: true,
        value: [first.pullRequest, ...entries.slice(1).map((entry) => entry.pullRequest)],
      }
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
  PullRequestNotFound: "not found or inaccessible",
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
          switch (state.ci) {
            case "failed":
            case "pending":
              return openAppearances[state.ci]
            case "none":
            case "passed":
              switch (state.blocker) {
                case "behind":
                  return { tone: "yellow", label: "branch behind", strikethrough: false }
                case "none":
                  return openAppearances[state.ci]
                default:
                  return casesHandled(state.blocker)
              }
            default:
              return casesHandled(state.ci)
          }
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
