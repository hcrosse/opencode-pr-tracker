import type { GitHubFailure, InvalidGitHubResponse, PullRequestNotFound } from "./github-types.js"
import { runAndDecode, type ProcessRunner } from "./github-transport.js"
import {
  parsePullRequestUrl,
  samePullRequest,
  sameRepository,
  type NonEmptyPullRequests,
  type PullRequestUrl,
  type Result,
} from "./url.js"

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

const maximumStackEntriesPerPage = 100
const stackEntrySelection = `nodes { position pullRequest { url } } totalCount pageInfo { hasNextPage endCursor }`
const stackQuery = `query PullRequestStack($url: URI!) { resource(url: $url) { __typename ... on PullRequest { url stack { id size entries(first: ${maximumStackEntriesPerPage}) { ${stackEntrySelection} } } } } }`
const stackContinuationQuery = `query PullRequestStackEntries($url: URI!, $cursor: String!) { resource(url: $url) { __typename ... on PullRequest { url stack { id size entries(first: ${maximumStackEntriesPerPage}, after: $cursor) { ${stackEntrySelection} } } } } }`

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function parseNonBlankString(input: unknown): string | undefined {
  return typeof input === "string" && input.trim() !== "" ? input : undefined
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

export async function getPullRequestStack(
  runner: ProcessRunner,
  pullRequest: PullRequestUrl,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<Result<NonEmptyPullRequests, GitHubFailure>> {
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
}
