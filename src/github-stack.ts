import type {
  GitHubBatchLimitExceeded,
  GitHubCancelled,
  GitHubFailure,
  GitHubStackBatch,
  InvalidGitHubResponse,
  PullRequestItemFailure,
  PullRequestNotFound,
  PullRequestStackMembership,
} from "./github-types.js"
import { runAndDecode, type ProcessRunner } from "./github-transport.js"
import {
  parsePullRequestUrl,
  samePullRequest,
  sameRepository,
  type NonEmptyPullRequests,
  type PullRequestUrl,
  type Result,
} from "./url.js"

const invalidGitHubResponseFailure: InvalidGitHubResponse = {
  tag: "InvalidGitHubResponse",
  message: "GitHub returned an invalid pull request response",
}
const invalidGitHubResponse: Result<never, InvalidGitHubResponse> = { ok: false, error: invalidGitHubResponseFailure }
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
const maximumStackEntriesPerPage = 100
const stackEntrySelection = `nodes { position pullRequest { url } } totalCount pageInfo { hasNextPage endCursor }`
const stackSelection = `__typename ... on PullRequest { url stack { id size entries(first: ${maximumStackEntriesPerPage}) { ${stackEntrySelection} } } }`
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
type ParsedInitialMembership =
  | Readonly<{ tag: "Standalone"; pullRequest: PullRequestUrl }>
  | Readonly<{ tag: "Stack"; requested: PullRequestUrl; page: ParsedStackPage }>

function parseStackPage(input: unknown, requested: PullRequestUrl): Result<ParsedStackPage, InvalidGitHubResponse> {
  if (!isRecord(input)) return invalidGitHubResponse
  const id = parseNonBlankString(input.id)
  const size = input.size
  if (id === undefined || !Number.isSafeInteger(size) || Number(size) <= 0 || !isRecord(input.entries)) {
    return invalidGitHubResponse
  }

  const entries = input.entries
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
  const positions = new Set<number>()
  const urls = new Set<string>()
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
    const position = Number(entry.position)
    if (
      !parsedUrl.ok ||
      !sameRepository(parsedUrl.value, requested) ||
      positions.has(position) ||
      urls.has(parsedUrl.value.url)
    ) {
      return invalidGitHubResponse
    }
    positions.add(position)
    urls.add(parsedUrl.value.url)
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

function parseStackResource(
  input: unknown,
  requested: PullRequestUrl,
): Result<ParsedInitialMembership, PullRequestNotFound | InvalidGitHubResponse> {
  if (input === null) return pullRequestNotFound
  if (!isRecord(input) || input.__typename !== "PullRequest" || typeof input.url !== "string") {
    return invalidGitHubResponse
  }
  const resourceUrl = parsePullRequestUrl(input.url)
  if (!resourceUrl.ok || !samePullRequest(resourceUrl.value, requested)) return invalidGitHubResponse
  if (input.stack === null) return { ok: true, value: { tag: "Standalone", pullRequest: requested } }
  const page = parseStackPage(input.stack, requested)
  return page.ok ? { ok: true, value: { tag: "Stack", requested, page: page.value } } : page
}

function createBatchQuery(size: number): string {
  const variables = Array.from({ length: size }, (_, index) => `$url${index}: URI!`).join(", ")
  const fields = Array.from(
    { length: size },
    (_, index) => `pr${index}: resource(url: $url${index}) { ${stackSelection} }`,
  ).join(" ")
  return `query BatchPullRequestStacks(${variables}) { ${fields} }`
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
  readonly Result<ParsedInitialMembership, PullRequestNotFound | InvalidGitHubResponse>[],
  InvalidGitHubResponse
> {
  if (!isRecord(input) || !isRecord(input.data)) return invalidGitHubResponse
  const data = input.data
  const errorAliases = parseGraphqlErrorAliases(input.errors, pullRequests.length)
  if (!errorAliases.ok) return errorAliases
  return {
    ok: true,
    value: pullRequests.map((pullRequest, index) =>
      errorAliases.value.has(index) ? invalidGitHubResponse : parseStackResource(data[`pr${index}`], pullRequest),
    ),
  }
}

function parseContinuationResponse(
  input: unknown,
  requested: PullRequestUrl,
): Result<ParsedStackPage, PullRequestNotFound | InvalidGitHubResponse> {
  if (
    !isRecord(input) ||
    (input.errors !== undefined && (!Array.isArray(input.errors) || input.errors.length > 0)) ||
    !isRecord(input.data)
  ) {
    return invalidGitHubResponse
  }
  const parsed = parseStackResource(input.data.resource, requested)
  if (!parsed.ok) return parsed
  return parsed.value.tag === "Stack" ? { ok: true, value: parsed.value.page } : invalidGitHubResponse
}

function pagesMatch(
  left: ParsedInitialMembership & { tag: "Stack" },
  right: ParsedInitialMembership & { tag: "Stack" },
): boolean {
  if (!sameRepository(left.requested, right.requested)) return false
  const leftPage = left.page
  const rightPage = right.page
  if (
    leftPage.size !== rightPage.size ||
    leftPage.totalCount !== rightPage.totalCount ||
    leftPage.nextCursor !== rightPage.nextCursor ||
    leftPage.entries.length !== rightPage.entries.length
  ) {
    return false
  }
  return leftPage.entries.every((entry, index) => {
    const peer = rightPage.entries[index]
    return (
      peer !== undefined && entry.position === peer.position && samePullRequest(entry.pullRequest, peer.pullRequest)
    )
  })
}

type StackContinuationOutcome =
  | Readonly<{ tag: "Membership"; membership: PullRequestStackMembership & { tag: "Stack" } }>
  | Readonly<{ tag: "ItemFailure"; error: PullRequestItemFailure }>
  | Readonly<{ tag: "Cancelled"; error: GitHubCancelled }>

async function continueStack(
  runner: ProcessRunner,
  initial: ParsedInitialMembership & { tag: "Stack" },
  options: Readonly<{ signal?: AbortSignal }>,
): Promise<StackContinuationOutcome> {
  const stackId = initial.page.stackId
  const size = initial.page.size
  const entries: ParsedStackEntry[] = []
  const seenCursors = new Set<string>()
  const seenPositions = new Set<number>()
  const seenUrls = new Set<string>()
  let page = initial.page

  while (true) {
    if (page.stackId !== stackId || page.size !== size || page.totalCount !== size) {
      return { tag: "ItemFailure", error: invalidGitHubResponseFailure }
    }
    if (entries.length + page.entries.length > size) {
      return { tag: "ItemFailure", error: invalidGitHubResponseFailure }
    }
    for (const entry of page.entries) {
      if (seenPositions.has(entry.position) || seenUrls.has(entry.pullRequest.url)) {
        return { tag: "ItemFailure", error: invalidGitHubResponseFailure }
      }
      seenPositions.add(entry.position)
      seenUrls.add(entry.pullRequest.url)
      entries.push(entry)
    }

    const nextCursor = page.nextCursor
    if (nextCursor === undefined) break
    if (seenCursors.has(nextCursor)) return { tag: "ItemFailure", error: invalidGitHubResponseFailure }
    seenCursors.add(nextCursor)

    const args = [
      "api",
      "graphql",
      "--method",
      "POST",
      "-f",
      `query=${stackContinuationQuery}`,
      "-f",
      `url=${initial.requested.url}`,
      "-f",
      `cursor=${nextCursor}`,
    ]
    const output = await runAndDecode(runner, args, options)
    if (!output.ok) {
      return output.error.tag === "GitHubCancelled"
        ? { tag: "Cancelled", error: output.error }
        : { tag: "ItemFailure", error: output.error }
    }
    const continuation = parseContinuationResponse(output.value.decoded, initial.requested)
    if (!continuation.ok) {
      return { tag: "ItemFailure", error: output.value.processFailure ?? continuation.error }
    }
    page = continuation.value
  }

  if (entries.length !== size) return { tag: "ItemFailure", error: invalidGitHubResponseFailure }
  for (let position = 1; position <= size; position += 1) {
    if (!seenPositions.has(position)) return { tag: "ItemFailure", error: invalidGitHubResponseFailure }
  }
  entries.sort((left, right) => left.position - right.position)
  const first = entries[0]
  if (first === undefined) return { tag: "ItemFailure", error: invalidGitHubResponseFailure }
  return {
    tag: "Membership",
    membership: {
      tag: "Stack",
      id: stackId,
      members: [first.pullRequest, ...entries.slice(1).map((entry) => entry.pullRequest)],
    },
  }
}

export async function getPullRequestStacks(
  runner: ProcessRunner,
  pullRequests: readonly PullRequestUrl[],
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<Result<GitHubStackBatch, GitHubFailure>> {
  if (pullRequests.length === 0) return { ok: true, value: [] }
  if (pullRequests.length > maximumPullRequestsPerBatch) return githubBatchLimitExceeded

  const query = createBatchQuery(pullRequests.length)
  const args = ["api", "graphql", "--method", "POST", "-f", `query=${query}`]
  for (const [index, pullRequest] of pullRequests.entries()) args.push("-f", `url${index}=${pullRequest.url}`)
  const output = await runAndDecode(runner, args, options)
  if (!output.ok) return output
  const parsed = parseBatchResponse(output.value.decoded, pullRequests)
  if (!parsed.ok) return { ok: false, error: output.value.processFailure ?? parsed.error }

  const batch: Result<PullRequestStackMembership, PullRequestItemFailure>[] = parsed.value.map((item) =>
    item.ok && item.value.tag === "Standalone" ? { ok: true, value: item.value } : invalidGitHubResponse,
  )
  const groups = new Map<string, Array<{ index: number; initial: ParsedInitialMembership & { tag: "Stack" } }>>()
  for (const [index, item] of parsed.value.entries()) {
    if (!item.ok || item.value.tag !== "Stack") {
      if (!item.ok) batch[index] = item
      continue
    }
    const group = groups.get(item.value.page.stackId) ?? []
    group.push({ index, initial: item.value })
    groups.set(item.value.page.stackId, group)
  }

  let cancellation: GitHubCancelled | undefined
  await Promise.all(
    [...groups.values()].map(async (group) => {
      const representative = group[0]
      if (representative === undefined) return
      if (group.some(({ initial }) => !pagesMatch(representative.initial, initial))) {
        for (const { index } of group) batch[index] = invalidGitHubResponse
        return
      }
      const outcome = await continueStack(runner, representative.initial, options)
      if (outcome.tag === "Cancelled") {
        cancellation ??= outcome.error
        return
      }
      if (outcome.tag === "ItemFailure") {
        for (const { index } of group) batch[index] = { ok: false, error: outcome.error }
        return
      }
      for (const { index, initial } of group) {
        batch[index] = outcome.membership.members.some((member) => samePullRequest(member, initial.requested))
          ? { ok: true, value: outcome.membership }
          : invalidGitHubResponse
      }
    }),
  )

  return cancellation === undefined ? { ok: true, value: batch } : { ok: false, error: cancellation }
}

export async function getPullRequestStack(
  runner: ProcessRunner,
  pullRequest: PullRequestUrl,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<Result<NonEmptyPullRequests, GitHubFailure>> {
  const batch = await getPullRequestStacks(runner, [pullRequest], options)
  if (!batch.ok) return batch
  const item = batch.value[0]
  if (item === undefined || !item.ok) return item ?? invalidGitHubResponse
  return {
    ok: true,
    value: item.value.tag === "Standalone" ? [item.value.pullRequest] : item.value.members,
  }
}
