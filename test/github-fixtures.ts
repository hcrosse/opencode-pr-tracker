import { type GitHubClient, type ProcessRunner } from "../src/github.js"
import { parsePullRequestUrl } from "../src/url.js"

const parsed = parsePullRequestUrl("https://github.com/owner/repository/pull/42")
if (!parsed.ok) throw new Error("test fixture URL is invalid")
export const pullRequest = parsed.value
const secondParsed = parsePullRequestUrl("https://github.com/another/project/pull/7")
if (!secondParsed.ok) throw new Error("second test fixture URL is invalid")
export const secondPullRequest = secondParsed.value

export const invalidItem = {
  ok: false,
  error: {
    tag: "InvalidGitHubResponse",
    message: "GitHub returned an invalid pull request response",
  },
} as const

export function runnerFor(
  output: unknown,
  calls: Array<{ file: string; args: readonly string[]; signal?: AbortSignal }> = [],
): ProcessRunner {
  return async (file, args, options) => {
    calls.push({ file, args, ...(options.signal ? { signal: options.signal } : {}) })
    return { stdout: JSON.stringify(output) }
  }
}

export function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    __typename: "PullRequest",
    title: "Add pull request tracking",
    state: "OPEN",
    url: pullRequest.url,
    mergedAt: null,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    baseRef: baseRefPolicy(),
    statusCheckRollup: rollup(),
    ...overrides,
  }
}

export function baseRefPolicy(
  input: Readonly<{
    branchProtectionRule?: unknown
    refUpdateRule?: unknown
    rules?: readonly unknown[]
    hasNextPage?: boolean
    totalCount?: number
  }> = {},
): Record<string, unknown> {
  const rules = input.rules ?? []
  return {
    branchProtectionRule: input.branchProtectionRule ?? null,
    refUpdateRule: input.refUpdateRule ?? null,
    rules: {
      nodes: rules,
      totalCount: input.totalCount ?? rules.length,
      pageInfo: { hasNextPage: input.hasNextPage ?? false },
    },
  }
}

export function rollup(
  input: Readonly<{
    nodes?: readonly unknown[] | null
    totalCount?: number
    hasNextPage?: boolean
    endCursor?: unknown
    overrides?: Record<string, unknown>
  }> = {},
): { contexts: Record<string, unknown> } {
  const nodes = "nodes" in input ? input.nodes : []
  const nodeCount = Array.isArray(nodes) ? nodes.length : 0
  return {
    contexts: {
      nodes,
      totalCount: input.totalCount ?? nodeCount,
      pageInfo: {
        hasNextPage: input.hasNextPage ?? false,
        endCursor: "endCursor" in input ? input.endCursor : nodeCount === 0 ? null : "cursor-1",
      },
      ...input.overrides,
    },
  }
}

export function checkRun(
  input: Readonly<{
    id?: unknown
    name?: unknown
    status?: unknown
    conclusion?: unknown
    suiteId?: unknown
    suiteCreatedAt?: unknown
    app?: unknown
    workflowRun?: unknown
    checkSuite?: unknown
  }> = {},
): Record<string, unknown> {
  const workflowRunValue =
    "workflowRun" in input
      ? input.workflowRun
      : {
          event: "pull_request",
          runNumber: 1,
          runAttempt: 1,
          workflow: { id: "workflow-1" },
        }
  const checkSuite =
    "checkSuite" in input
      ? input.checkSuite
      : {
          id: input.suiteId ?? "suite-1",
          createdAt: input.suiteCreatedAt ?? "2026-08-10T10:00:00Z",
          app: "app" in input ? input.app : { id: "app-1" },
          workflowRun: workflowRunValue,
        }
  return {
    __typename: "CheckRun",
    id: input.id ?? "check-run-1",
    name: input.name ?? "Build",
    status: input.status ?? "COMPLETED",
    conclusion: "conclusion" in input ? input.conclusion : "SUCCESS",
    checkSuite,
  }
}

export function batchResponse(...responses: readonly unknown[]): Record<string, unknown> {
  return {
    data: Object.fromEntries(responses.map((value, index) => [`pr${index}`, value])),
  }
}

export function processExecutionFailed(
  code: string | number | null,
  stdout = "",
  stderr = "request failed",
): Readonly<Record<string, unknown>> {
  return {
    tag: "ProcessExecutionFailed",
    code,
    stderr,
    stdout,
    cause: new Error("gh failed"),
  }
}

export function fieldValue(args: readonly string[], field: string): string | undefined {
  return args.find((arg) => arg.startsWith(`${field}=`))?.slice(field.length + 1)
}

export async function getOne(client: GitHubClient) {
  const result = await client.get([pullRequest])
  if (!result.ok) throw new Error("expected GitHub batch to parse")
  const item = result.value[0]
  if (item === undefined || !item.ok) throw new Error("expected pull request response to parse")
  return item.value
}
