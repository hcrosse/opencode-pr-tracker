import { describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createGitHubClient,
  execFileRunner,
  statusAppearance,
  type GitHubClient,
  type ProcessRunner,
} from "../src/github.js"
import { parsePullRequestUrl } from "../src/url.js"

const parsed = parsePullRequestUrl("https://github.com/owner/repository/pull/42")
if (!parsed.ok) throw new Error("test fixture URL is invalid")
const pullRequest = parsed.value
const secondParsed = parsePullRequestUrl("https://github.com/another/project/pull/7")
if (!secondParsed.ok) throw new Error("second test fixture URL is invalid")
const secondPullRequest = secondParsed.value
const successChecks = { nodes: [checkRun()] }
const pendingChecks = { nodes: [checkRun({ status: "IN_PROGRESS", conclusion: null })] }
const failedChecks = { nodes: [checkRun({ conclusion: "FAILURE" })] }
const strictStatusCheckRule = {
  parameters: {
    __typename: "RequiredStatusChecksParameters",
    strictRequiredStatusChecksPolicy: true,
    requiredStatusChecks: [{ context: "Build" }],
  },
}
const invalidItem = {
  ok: false,
  error: {
    tag: "InvalidGitHubResponse",
    message: "GitHub returned an invalid pull request response",
  },
} as const

function runnerFor(
  output: unknown,
  calls: Array<{ file: string; args: readonly string[]; signal?: AbortSignal }> = [],
): ProcessRunner {
  return async (file, args, options) => {
    calls.push({ file, args, ...(options.signal ? { signal: options.signal } : {}) })
    return { stdout: JSON.stringify(output) }
  }
}

function response(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function baseRefPolicy(
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

function rollup(
  input: Readonly<{
    nodes?: readonly unknown[] | null
    totalCount?: number
    hasNextPage?: boolean
    endCursor?: unknown
    overrides?: Record<string, unknown>
  }> = {},
): Record<string, unknown> {
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

function checkRun(
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
    id: input.id ?? "check-run-1",
    name: input.name ?? "Build",
    status: input.status ?? "COMPLETED",
    conclusion: "conclusion" in input ? input.conclusion : "SUCCESS",
    checkSuite,
  }
}

function statusContext(
  input: Readonly<{
    id?: unknown
    context?: unknown
    state?: unknown
    createdAt?: unknown
  }> = {},
): Record<string, unknown> {
  return {
    id: input.id ?? "status-context-1",
    context: input.context ?? "Build",
    state: input.state ?? "SUCCESS",
    createdAt: input.createdAt ?? "2026-08-10T10:00:00Z",
  }
}

function workflowRun(
  input: Readonly<{
    event?: unknown
    runNumber?: unknown
    runAttempt?: unknown
    workflowId?: unknown
    workflow?: unknown
  }> = {},
): Record<string, unknown> {
  return {
    event: input.event ?? "pull_request",
    runNumber: input.runNumber ?? 1,
    runAttempt: input.runAttempt ?? 1,
    workflow: "workflow" in input ? input.workflow : { id: input.workflowId ?? "workflow-1" },
  }
}

function batchResponse(...responses: readonly unknown[]): Record<string, unknown> {
  return {
    data: Object.fromEntries(responses.map((value, index) => [`pr${index}`, value])),
  }
}

async function getOne(client: GitHubClient) {
  const result = await client.get([pullRequest])
  if (!result.ok) throw new Error("expected GitHub batch to parse")
  const item = result.value[0]
  if (item === undefined || !item.ok) throw new Error("expected pull request response to parse")
  return item.value
}

function processFailureRunner(code: number, stderr: string): ProcessRunner {
  return (_file, _args, options) =>
    execFileRunner(
      process.execPath,
      ["-e", `process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code})`],
      options,
    )
}

describe("GitHub client", () => {
  test("batches mixed-repository pull requests through one fixed gh graphql invocation", async () => {
    const calls: Array<{ file: string; args: readonly string[]; signal?: AbortSignal }> = []
    const client = createGitHubClient(
      runnerFor(batchResponse(response(), response({ url: secondPullRequest.url })), calls),
    )
    const controller = new AbortController()

    await client.get([pullRequest, secondPullRequest], { signal: controller.signal })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ file: "gh", signal: controller.signal })
    expect(calls[0]?.args.slice(0, 5)).toEqual(["api", "graphql", "--method", "POST", "-f"])
    expect(calls[0]?.args[5]).toContain("query BatchPullRequests($url0: URI!, $url1: URI!)")
    expect(calls[0]?.args[5]).toContain("pr0: resource(url: $url0)")
    expect(calls[0]?.args[5]).toContain("pr1: resource(url: $url1)")
    expect(calls[0]?.args[5]).toContain("title state url mergedAt mergeable mergeStateStatus")
    expect(calls[0]?.args[5]).toContain("statusCheckRollup { contexts(first: 100)")
    expect(calls[0]?.args[5]).toContain("... on StatusContext { id context state createdAt }")
    expect(calls[0]?.args[5]).toContain("... on CheckRun { id name status conclusion")
    expect(calls[0]?.args[5]).toContain("checkSuite { id createdAt app { id }")
    expect(calls[0]?.args[5]).toContain("workflowRun { event runNumber runAttempt workflow { id } }")
    expect(calls[0]?.args[5]).toContain("totalCount pageInfo { hasNextPage endCursor }")
    expect(calls[0]?.args[5]).not.toContain("checkRunCountsByState")
    expect(calls[0]?.args[5]).not.toContain("statusContextCountsByState")
    expect(calls[0]?.args[5]).toContain("mergeStateStatus")
    expect(calls[0]?.args[5]).toContain("requiresStrictStatusChecks")
    expect(calls[0]?.args[5]).toContain("requiredStatusCheckContexts")
    expect(calls[0]?.args[5]).toContain("strictRequiredStatusChecksPolicy")
    expect(calls[0]?.args.slice(6)).toEqual(["-f", `url0=${pullRequest.url}`, "-f", `url1=${secondPullRequest.url}`])
  })

  test("returns GitHubCancelled when its signal aborts", async () => {
    const controller = new AbortController()
    const cause = new Error("aborted")
    const client = createGitHubClient(
      (_file, _args, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(cause), { once: true })
        }),
    )

    const request = client.get([pullRequest], { signal: controller.signal })
    controller.abort()

    expect(await request).toEqual({
      ok: false,
      error: {
        tag: "GitHubCancelled",
        message: "GitHub status request cancelled",
        cause,
      },
    })
  })

  test("classifies a missing GitHub CLI executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-pr-tracker-"))
    try {
      const client = createGitHubClient((_file, args, options) =>
        execFileRunner(join(directory, "missing-gh"), args, options),
      )

      const result = await client.get([pullRequest])

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.tag).toBe("GitHubCliMissing")
      expect(result.error.message).toBe("GitHub CLI is not installed")
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  test("runs processes in the requested working directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-pr-tracker-"))
    try {
      const result = await execFileRunner(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
        cwd: directory,
      })

      expect(result.stdout).toBe(await realpath(directory))
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  test.each([
    { name: "exit code 4", code: 4, stderr: "request failed" },
    { name: "HTTP 401", code: 1, stderr: "HTTP 401\ncredential=secret-value" },
    { name: "Bad credentials", code: 1, stderr: "Bad credentials\ncredential=secret-value" },
    {
      name: "not logged into",
      code: 1,
      stderr: "not logged into any GitHub hosts\ncredential=secret-value",
    },
    { name: "gh auth login", code: 1, stderr: "Run gh auth login to authenticate\ncredential=secret-value" },
  ])("classifies authentication required from $name", async ({ code, stderr }) => {
    const credentialFragment = "credential=secret-value"
    const client = createGitHubClient(processFailureRunner(code, stderr))

    const result = await client.get([pullRequest])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.tag).toBe("GitHubAuthenticationRequired")
    expect(result.error.message).toBe("GitHub CLI authentication required")
    expect(result.error.message).not.toContain(credentialFragment)
    expect(result.error.tag).not.toContain(credentialFragment)
  })

  test.each([
    { name: "credential-shaped stderr", stderr: "credential=secret-value" },
    { name: "unspecified authentication wording", stderr: "authentication failed\ncredential=secret-value" },
  ])("keeps $name unavailable without exposing stderr", async ({ stderr }) => {
    const credentialFragment = "credential=secret-value"
    const client = createGitHubClient(processFailureRunner(1, stderr))

    const result = await client.get([pullRequest])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.tag).toBe("GitHubUnavailable")
    expect(result.error.message).toBe("GitHub status unavailable")
    expect(result.error.message).not.toContain(credentialFragment)
    expect(result.error.tag).not.toContain(credentialFragment)
  })

  test("keeps adapter cancellation distinct from process failures", async () => {
    const processController = new AbortController()
    const client = createGitHubClient((_file, _args, _options) =>
      execFileRunner(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], { signal: processController.signal }),
    )

    const request = client.get([pullRequest])
    processController.abort()
    const result = await request

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.tag).toBe("GitHubCancelled")
    expect(result.error.message).toBe("GitHub status request cancelled")
  })

  test.each([
    { name: "no checks", contexts: {}, expected: "none" },
    {
      name: "successful check run",
      contexts: successChecks,
      expected: "passed",
    },
    {
      name: "successful status context",
      contexts: { nodes: [statusContext()] },
      expected: "passed",
    },
    {
      name: "pending check",
      contexts: pendingChecks,
      expected: "pending",
    },
    {
      name: "pending status context",
      contexts: { nodes: [statusContext({ state: "PENDING" })] },
      expected: "pending",
    },
    {
      name: "failure wins over pending",
      contexts: {
        nodes: [
          checkRun({ id: "pending", name: "Lint", status: "IN_PROGRESS", conclusion: null }),
          checkRun({ id: "failed", conclusion: "FAILURE" }),
        ],
      },
      expected: "failed",
    },
    {
      name: "error status fails",
      contexts: { nodes: [statusContext({ state: "ERROR" })] },
      expected: "failed",
    },
    {
      name: "neutral and skipped checks are absent",
      contexts: {
        nodes: [
          checkRun({ id: "neutral", name: "Neutral", conclusion: "NEUTRAL" }),
          checkRun({ id: "skipped", name: "Skipped", conclusion: "SKIPPED" }),
        ],
      },
      expected: "none",
    },
    {
      name: "completed check without a conclusion is absent",
      contexts: { nodes: [checkRun({ conclusion: null })] },
      expected: "none",
    },
  ])("classifies $name", async ({ contexts, expected }) => {
    const client = createGitHubClient(runnerFor(batchResponse(response({ statusCheckRollup: rollup(contexts) }))))

    expect((await getOne(client)).state).toEqual({
      tag: "Open",
      ci: expected,
      mergeability: "mergeable",
      blocker: "none",
    })
  })

  test("classifies every current non-completed check status as pending", async () => {
    const nodes = ["REQUESTED", "QUEUED", "IN_PROGRESS", "WAITING", "PENDING"].map((status, index) =>
      checkRun({ id: `pending-${index}`, name: `Check ${index}`, status, conclusion: null }),
    )
    const client = createGitHubClient(runnerFor(batchResponse(response({ statusCheckRollup: rollup({ nodes }) }))))

    expect((await getOne(client)).state).toEqual({
      tag: "Open",
      ci: "pending",
      mergeability: "mergeable",
      blocker: "none",
    })
  })

  test.each([
    {
      name: "a successful newer run",
      nodes: [
        checkRun({
          id: "old-cancelled",
          suiteId: "suite-10",
          conclusion: "CANCELLED",
          workflowRun: workflowRun({ runNumber: 10 }),
        }),
        checkRun({ id: "new-success", suiteId: "suite-11", workflowRun: workflowRun({ runNumber: 11 }) }),
      ],
      expected: "passed",
    },
    {
      name: "a cancelled newer run",
      nodes: [
        checkRun({ id: "old-success", suiteId: "suite-10", workflowRun: workflowRun({ runNumber: 10 }) }),
        checkRun({
          id: "new-cancelled",
          suiteId: "suite-11",
          conclusion: "CANCELLED",
          workflowRun: workflowRun({ runNumber: 11 }),
        }),
      ],
      expected: "failed",
    },
    {
      name: "an in-progress newer run",
      nodes: [
        checkRun({
          id: "old-cancelled",
          suiteId: "suite-10",
          conclusion: "CANCELLED",
          workflowRun: workflowRun({ runNumber: 10 }),
        }),
        checkRun({
          id: "new-pending",
          suiteId: "suite-11",
          status: "IN_PROGRESS",
          conclusion: null,
          workflowRun: workflowRun({ runNumber: 11 }),
        }),
      ],
      expected: "pending",
    },
    {
      name: "a successful newer attempt",
      nodes: [
        checkRun({
          id: "old-attempt",
          suiteId: "suite-11-1",
          conclusion: "CANCELLED",
          workflowRun: workflowRun({ runNumber: 11, runAttempt: 1 }),
        }),
        checkRun({
          id: "new-attempt",
          suiteId: "suite-11-2",
          workflowRun: workflowRun({ runNumber: 11, runAttempt: 2 }),
        }),
      ],
      expected: "passed",
    },
  ])("classifies $name as $expected", async ({ nodes, expected }) => {
    const client = createGitHubClient(runnerFor(batchResponse(response({ statusCheckRollup: rollup({ nodes }) }))))

    expect((await getOne(client)).state).toMatchObject({ tag: "Open", ci: expected })
  })

  test.each([
    {
      name: "app",
      old: { app: { id: "app-1" }, workflowRun: workflowRun({ runNumber: 10 }) },
      replacement: { app: { id: "app-2" }, workflowRun: workflowRun({ runNumber: 11 }) },
    },
    {
      name: "workflow",
      old: { workflowRun: workflowRun({ runNumber: 10, workflowId: "workflow-1" }) },
      replacement: { workflowRun: workflowRun({ runNumber: 11, workflowId: "workflow-2" }) },
    },
    {
      name: "event",
      old: { workflowRun: workflowRun({ event: "pull_request", runNumber: 10 }) },
      replacement: { workflowRun: workflowRun({ event: "push", runNumber: 11 }) },
    },
  ])("keeps same-named workflow checks from different $name identities independent", async ({ old, replacement }) => {
    const nodes = [
      checkRun({ id: "old", suiteId: "old-suite", conclusion: "CANCELLED", ...old }),
      checkRun({ id: "replacement", suiteId: "replacement-suite", ...replacement }),
    ]
    const client = createGitHubClient(runnerFor(batchResponse(response({ statusCheckRollup: rollup({ nodes }) }))))

    expect((await getOne(client)).state).toMatchObject({ tag: "Open", ci: "failed" })
  })

  test("retains every duplicate workflow check in the newest generation", async () => {
    const generation = workflowRun({ runNumber: 11, runAttempt: 2 })
    const nodes = [
      checkRun({ id: "success", suiteId: "suite-success", workflowRun: generation }),
      checkRun({ id: "failure", suiteId: "suite-failure", conclusion: "FAILURE", workflowRun: generation }),
    ]
    const client = createGitHubClient(runnerFor(batchResponse(response({ statusCheckRollup: rollup({ nodes }) }))))

    expect((await getOne(client)).state).toMatchObject({ tag: "Open", ci: "failed" })
  })

  test("uses the newest check suite for non-workflow checks", async () => {
    const nodes = [
      checkRun({
        id: "old",
        suiteId: "old-suite",
        suiteCreatedAt: "2026-08-10T09:00:00Z",
        conclusion: "CANCELLED",
        workflowRun: null,
      }),
      checkRun({
        id: "new",
        suiteId: "new-suite",
        suiteCreatedAt: "2026-08-10T10:00:00Z",
        workflowRun: null,
      }),
    ]
    const client = createGitHubClient(runnerFor(batchResponse(response({ statusCheckRollup: rollup({ nodes }) }))))

    expect((await getOne(client)).state).toMatchObject({ tag: "Open", ci: "passed" })
  })

  test("retains non-workflow checks from every tied newest suite", async () => {
    const nodes = [
      checkRun({ id: "success", suiteId: "suite-a", workflowRun: null }),
      checkRun({ id: "failure", suiteId: "suite-b", conclusion: "FAILURE", workflowRun: null }),
    ]
    const client = createGitHubClient(runnerFor(batchResponse(response({ statusCheckRollup: rollup({ nodes }) }))))

    expect((await getOne(client)).state).toMatchObject({ tag: "Open", ci: "failed" })
  })

  test("uses suite identity for non-workflow checks without an app", async () => {
    const nodes = [
      checkRun({
        id: "old",
        suiteId: "anonymous-suite-a",
        suiteCreatedAt: "2026-08-10T09:00:00Z",
        app: null,
        conclusion: "CANCELLED",
        workflowRun: null,
      }),
      checkRun({
        id: "new",
        suiteId: "anonymous-suite-b",
        suiteCreatedAt: "2026-08-10T10:00:00Z",
        app: null,
        workflowRun: null,
      }),
    ]
    const client = createGitHubClient(runnerFor(batchResponse(response({ statusCheckRollup: rollup({ nodes }) }))))

    expect((await getOne(client)).state).toMatchObject({ tag: "Open", ci: "failed" })
  })

  test("uses the newest status context case-insensitively", async () => {
    const nodes = [
      statusContext({ id: "old", context: "BUILD", state: "FAILURE", createdAt: "2026-08-10T09:00:00Z" }),
      statusContext({ id: "new", context: "build", createdAt: "2026-08-10T10:00:00Z" }),
    ]
    const client = createGitHubClient(runnerFor(batchResponse(response({ statusCheckRollup: rollup({ nodes }) }))))

    expect((await getOne(client)).state).toMatchObject({ tag: "Open", ci: "passed" })
  })

  test("retains every status context tied for newest", async () => {
    const nodes = [
      statusContext({ id: "success", context: "Build" }),
      statusContext({ id: "failure", context: "BUILD", state: "FAILURE" }),
    ]
    const client = createGitHubClient(runnerFor(batchResponse(response({ statusCheckRollup: rollup({ nodes }) }))))

    expect((await getOne(client)).state).toMatchObject({ tag: "Open", ci: "failed" })
  })

  test("fails an incomplete check-context connection closed", async () => {
    const client = createGitHubClient(
      runnerFor(
        batchResponse(
          response({
            statusCheckRollup: rollup({
              nodes: [checkRun()],
              totalCount: 101,
              hasNextPage: true,
              endCursor: "cursor-1",
            }),
          }),
        ),
      ),
    )

    const result = await client.get([pullRequest])

    expect(result.ok && result.value[0]).toEqual(invalidItem)
  })

  test.each([
    { raw: "MERGEABLE", expected: "mergeable" },
    { raw: "CONFLICTING", expected: "conflicting" },
    { raw: "UNKNOWN", expected: "unknown" },
  ])("parses $raw mergeability", async ({ raw, expected }) => {
    const client = createGitHubClient(runnerFor(batchResponse(response({ mergeable: raw }))))

    expect((await getOne(client)).state).toEqual({ tag: "Open", ci: "none", mergeability: expected, blocker: "none" })
  })

  test.each([
    {
      name: "strict branch protection",
      overrides: {
        mergeStateStatus: "BEHIND",
        baseRef: baseRefPolicy({
          branchProtectionRule: { requiresStatusChecks: true, requiresStrictStatusChecks: true },
        }),
      },
      expected: "behind",
    },
    {
      name: "strict applicable ruleset",
      overrides: {
        mergeStateStatus: "BEHIND",
        baseRef: baseRefPolicy({ rules: [strictStatusCheckRule] }),
      },
      expected: "behind",
    },
    {
      name: "non-strict branch protection",
      overrides: {
        mergeStateStatus: "BEHIND",
        baseRef: baseRefPolicy({
          branchProtectionRule: { requiresStatusChecks: true, requiresStrictStatusChecks: false },
        }),
      },
      expected: "none",
    },
    {
      name: "generic blocked state",
      overrides: {
        mergeStateStatus: "BLOCKED",
        baseRef: {},
      },
      expected: "none",
    },
    {
      name: "deprecated draft state",
      overrides: {
        mergeStateStatus: "DRAFT",
        baseRef: {},
      },
      expected: "none",
    },
    {
      name: "strict ruleset without required checks",
      overrides: {
        mergeStateStatus: "BEHIND",
        baseRef: baseRefPolicy({
          rules: [
            {
              parameters: {
                __typename: "RequiredStatusChecksParameters",
                strictRequiredStatusChecksPolicy: true,
                requiredStatusChecks: [],
              },
            },
          ],
        }),
      },
      expected: "none",
    },
    {
      name: "strict rule found before an incomplete page",
      overrides: {
        mergeStateStatus: "BEHIND",
        baseRef: baseRefPolicy({ rules: [strictStatusCheckRule], hasNextPage: true, totalCount: 101 }),
      },
      expected: "behind",
    },
  ])("classifies $name as $expected", async ({ overrides, expected }) => {
    const client = createGitHubClient(runnerFor(batchResponse(response(overrides))))

    expect((await getOne(client)).state).toEqual({
      tag: "Open",
      ci: "none",
      mergeability: "mergeable",
      blocker: expected,
    })
  })

  test("rejects a behind pull request when applicable rules may be on another page", async () => {
    const client = createGitHubClient(
      runnerFor(
        batchResponse(
          response({
            mergeStateStatus: "BEHIND",
            baseRef: baseRefPolicy({ hasNextPage: true, totalCount: 101 }),
          }),
        ),
      ),
    )

    const result = await client.get([pullRequest])

    expect(result.ok && result.value[0]).toEqual(invalidItem)
  })

  test("rejects a behind pull request when classic strict policy is hidden from the viewer", async () => {
    const client = createGitHubClient(
      runnerFor(
        batchResponse(
          response({
            mergeStateStatus: "BEHIND",
            baseRef: baseRefPolicy({ refUpdateRule: { requiredStatusCheckContexts: ["Build"] } }),
          }),
        ),
      ),
    )

    const result = await client.get([pullRequest])

    expect(result.ok && result.value[0]).toEqual(invalidItem)
  })

  test("shows a policy-backed behind branch after successful checks", async () => {
    const client = createGitHubClient(
      runnerFor(
        batchResponse(
          response({
            mergeStateStatus: "BEHIND",
            baseRef: baseRefPolicy({ rules: [strictStatusCheckRule] }),
            statusCheckRollup: rollup(successChecks),
          }),
        ),
      ),
    )

    expect(statusAppearance(await getOne(client))).toEqual({
      tone: "yellow",
      label: "branch behind",
      strikethrough: false,
    })
  })

  test.each([
    {
      state: "MERGED",
      mergedAt: "2026-08-10T12:00:00Z",
      contexts: {},
      tone: "purple",
      label: "merged",
      strike: true,
    },
    { state: "CLOSED", mergedAt: null, contexts: {}, tone: "red", label: "closed", strike: true },
    { state: "OPEN", mergedAt: null, contexts: {}, tone: "gray", label: "no checks", strike: false },
    {
      state: "OPEN",
      mergedAt: null,
      contexts: successChecks,
      tone: "green",
      label: "checks passed",
      strike: false,
    },
    {
      state: "OPEN",
      mergedAt: null,
      contexts: pendingChecks,
      tone: "yellow",
      label: "checks pending",
      strike: false,
    },
    {
      state: "OPEN",
      mergedAt: null,
      contexts: failedChecks,
      tone: "red",
      label: "checks failed",
      strike: false,
    },
  ])("projects $state status with $label appearance", async ({ state, mergedAt, contexts, tone, label, strike }) => {
    const client = createGitHubClient(
      runnerFor(batchResponse(response({ state, mergedAt, statusCheckRollup: rollup(contexts) }))),
    )

    expect(statusAppearance(await getOne(client))).toEqual({ tone, label, strikethrough: strike })
  })

  test("gives an open merge conflict precedence over CI", async () => {
    const client = createGitHubClient(
      runnerFor(
        batchResponse(
          response({
            mergeable: "CONFLICTING",
            mergeStateStatus: "BEHIND",
            baseRef: baseRefPolicy({ refUpdateRule: { requiredStatusCheckContexts: ["Build"] } }),
            statusCheckRollup: rollup(successChecks),
          }),
        ),
      ),
    )

    expect(statusAppearance(await getOne(client))).toEqual({
      tone: "red",
      label: "merge conflict",
      strikethrough: false,
    })
  })

  test.each([
    {
      contexts: pendingChecks,
      policy: baseRefPolicy({ refUpdateRule: { requiredStatusCheckContexts: ["Build"] } }),
      tone: "yellow",
      label: "checks pending",
    },
    {
      contexts: failedChecks,
      policy: baseRefPolicy({ hasNextPage: true, totalCount: 101 }),
      tone: "red",
      label: "checks failed",
    },
  ])("gives $label precedence over inconclusive blocker policy", async ({ contexts, policy, tone, label }) => {
    const client = createGitHubClient(
      runnerFor(
        batchResponse(
          response({
            mergeStateStatus: "BEHIND",
            baseRef: policy,
            statusCheckRollup: rollup(contexts),
          }),
        ),
      ),
    )

    expect(statusAppearance(await getOne(client))).toEqual({ tone, label, strikethrough: false })
  })

  test("uses CI while GitHub computes mergeability", async () => {
    const client = createGitHubClient(
      runnerFor(batchResponse(response({ mergeable: "UNKNOWN", statusCheckRollup: rollup(pendingChecks) }))),
    )

    expect(statusAppearance(await getOne(client))).toEqual({
      tone: "yellow",
      label: "checks pending",
      strikethrough: false,
    })
  })

  test.each([
    { state: "MERGED", mergedAt: "2026-08-10T12:00:00Z", expected: { tag: "Merged" } },
    { state: "CLOSED", mergedAt: null, expected: { tag: "Closed" } },
  ])("accepts valid checks without retaining CI for $state pull requests", async ({ state, mergedAt, expected }) => {
    const client = createGitHubClient(
      runnerFor(batchResponse(response({ state, mergedAt, statusCheckRollup: rollup(failedChecks) }))),
    )

    expect((await getOne(client)).state).toEqual(expected)
  })

  test.each([
    { state: "MERGED", mergedAt: "2026-08-10T12:00:00Z", expected: { tag: "Merged" } },
    { state: "CLOSED", mergedAt: null, expected: { tag: "Closed" } },
  ])("keeps $state lifecycle authoritative over malformed blocker policy", async ({ state, mergedAt, expected }) => {
    const client = createGitHubClient(
      runnerFor(batchResponse(response({ state, mergedAt, mergeStateStatus: "NEW_STATE", baseRef: {} }))),
    )

    expect((await getOne(client)).state).toEqual(expected)
  })

  test("classifies execution failures without exposing credentials", async () => {
    const cause = new Error("gh auth token secret")
    const client = createGitHubClient(async () => {
      throw cause
    })

    expect(await client.get([pullRequest])).toEqual({
      ok: false,
      error: {
        tag: "GitHubUnavailable",
        message: "GitHub status unavailable",
        cause,
      },
    })
  })

  test.each([
    "not json",
    JSON.stringify({ title: "Missing fields" }),
    JSON.stringify({ data: [] }),
    JSON.stringify({ data: { pr0: null }, errors: [{ path: ["pr0"] }] }),
  ])("rejects malformed GraphQL envelopes", async (stdout) => {
    const client = createGitHubClient(async () => ({ stdout }))

    expect(await client.get([pullRequest])).toEqual({
      ok: false,
      error: {
        tag: "InvalidGitHubResponse",
        message: "GitHub returned an invalid pull request response",
      },
    })
  })

  test.each([
    response({ state: "UNKNOWN" }),
    response({ state: "CLOSED", mergedAt: "2026-08-10T12:00:00Z" }),
    response({ statusCheckRollup: rollup({ nodes: [statusContext({ state: "UNKNOWN" })] }) }),
    response({ statusCheckRollup: rollup({ nodes: [checkRun({ status: "UNKNOWN" })] }) }),
    response({ statusCheckRollup: rollup({ nodes: [checkRun({ conclusion: "UNKNOWN" })] }) }),
    response({ statusCheckRollup: rollup({ nodes: [statusContext({ createdAt: "not-a-date" })] }) }),
    response({ statusCheckRollup: rollup({ nodes: [statusContext({ createdAt: "2026-02-30T10:00:00Z" })] }) }),
    response({ statusCheckRollup: rollup({ nodes: [checkRun({ suiteCreatedAt: "not-a-date" })] }) }),
    response({ statusCheckRollup: rollup({ nodes: [statusContext({ id: "" })] }) }),
    response({ statusCheckRollup: rollup({ nodes: [statusContext({ context: " " })] }) }),
    response({ statusCheckRollup: rollup({ nodes: [checkRun({ id: "" })] }) }),
    response({ statusCheckRollup: rollup({ nodes: [checkRun({ name: " " })] }) }),
    response({ statusCheckRollup: rollup({ nodes: [checkRun({ suiteId: "" })] }) }),
    response({ statusCheckRollup: rollup({ nodes: [checkRun({ app: { id: "" } })] }) }),
    response({
      statusCheckRollup: rollup({ nodes: [checkRun({ workflowRun: workflowRun({ workflowId: "" }) })] }),
    }),
    response({
      statusCheckRollup: rollup({ nodes: [checkRun({ workflowRun: workflowRun({ event: "" }) })] }),
    }),
    response({
      statusCheckRollup: rollup({ nodes: [checkRun({ workflowRun: workflowRun({ runNumber: 0 }) })] }),
    }),
    response({
      statusCheckRollup: rollup({ nodes: [checkRun({ workflowRun: workflowRun({ runAttempt: 0 }) })] }),
    }),
    response({
      statusCheckRollup: rollup({
        nodes: [checkRun({ status: "IN_PROGRESS", conclusion: "SUCCESS" })],
      }),
    }),
    response({ statusCheckRollup: rollup({ overrides: { nodes: "invalid" } }) }),
    response({ statusCheckRollup: rollup({ overrides: { totalCount: -1 } }) }),
    response({ statusCheckRollup: rollup({ overrides: { pageInfo: null } }) }),
    response({
      statusCheckRollup: rollup({ overrides: { pageInfo: { hasNextPage: false, endCursor: 42 } } }),
    }),
    response({ statusCheckRollup: rollup({ nodes: [checkRun()], totalCount: 2 }) }),
    response({
      statusCheckRollup: rollup({ nodes: [checkRun(), checkRun()], totalCount: 2 }),
    }),
    response({
      state: "MERGED",
      mergedAt: "2026-08-10T12:00:00Z",
      statusCheckRollup: rollup({ nodes: [checkRun({ status: "UNKNOWN" })] }),
    }),
    response({
      state: "CLOSED",
      statusCheckRollup: rollup({ nodes: [checkRun({ status: "UNKNOWN" })] }),
    }),
    response({ url: "https://example.com/owner/repository/pull/42" }),
    response({ mergeable: "BLOCKED" }),
    response({ mergeStateStatus: "NEW_STATE" }),
    response({ mergeStateStatus: "BEHIND", baseRef: {} }),
    response({
      mergeStateStatus: "BEHIND",
      baseRef: baseRefPolicy({ branchProtectionRule: { requiresStatusChecks: true } }),
    }),
    response({ mergeStateStatus: "BEHIND", baseRef: baseRefPolicy({ refUpdateRule: {} }) }),
    response({
      mergeStateStatus: "BEHIND",
      baseRef: baseRefPolicy({ refUpdateRule: { requiredStatusCheckContexts: [""] } }),
    }),
    response({ mergeStateStatus: "BEHIND", baseRef: { branchProtectionRule: null, rules: null } }),
    response({ mergeStateStatus: "BEHIND", baseRef: baseRefPolicy({ totalCount: 1 }) }),
    response({
      mergeStateStatus: "BEHIND",
      baseRef: baseRefPolicy({ rules: [strictStatusCheckRule], hasNextPage: true }),
    }),
    response({
      mergeStateStatus: "BEHIND",
      baseRef: baseRefPolicy({
        rules: [
          {
            parameters: {
              __typename: "RequiredStatusChecksParameters",
              strictRequiredStatusChecksPolicy: true,
              requiredStatusChecks: [{ context: "" }],
            },
          },
        ],
      }),
    }),
    response({ __typename: "Issue" }),
  ])("isolates malformed pull request data to its batch item", async (item) => {
    const client = createGitHubClient(runnerFor(batchResponse(item, response({ url: secondPullRequest.url }))))

    const result = await client.get([pullRequest, secondPullRequest])

    expect(result.ok && result.value[0]).toEqual(invalidItem)
    expect(result.ok && result.value[1]).toMatchObject({ ok: true, value: { pullRequest: secondPullRequest } })
  })

  test("preserves successful aliases when gh reports a partial GraphQL error", async () => {
    const stdout = JSON.stringify({
      data: { pr0: response(), pr1: null },
      errors: [{ message: "Resource could not be resolved", path: ["pr1"] }],
    })
    const client = createGitHubClient(async () => ({ stdout }))

    const result = await client.get([pullRequest, secondPullRequest])

    expect(result.ok && result.value[0]).toMatchObject({ ok: true, value: { pullRequest } })
    expect(result.ok && result.value[1]).toEqual(invalidItem)
  })

  test("parses partial GraphQL data retained on a failed gh process", async () => {
    const stdout = JSON.stringify({
      data: { pr0: response(), pr1: null },
      errors: [{ message: "Resource could not be resolved", path: ["pr1"] }],
    })
    const client = createGitHubClient(async () => {
      throw Object.assign(new Error("GraphQL request failed"), { stdout })
    })

    const result = await client.get([pullRequest, secondPullRequest])

    expect(result.ok && result.value[0]).toMatchObject({ ok: true, value: { pullRequest } })
    expect(result.ok && result.value[1]).toEqual(invalidItem)
  })

  test("does not start a process for an empty batch", async () => {
    let calls = 0
    const client = createGitHubClient(async () => {
      calls += 1
      return { stdout: "" }
    })

    expect(await client.get([])).toEqual({ ok: true, value: [] })
    expect(calls).toBe(0)
  })

  test("returns a typed failure before starting a batch above the attachment limit", async () => {
    let calls = 0
    const client = createGitHubClient(async () => {
      calls += 1
      return { stdout: "" }
    })

    expect(await client.get(Array.from({ length: 21 }, () => pullRequest))).toEqual({
      ok: false,
      error: {
        tag: "GitHubBatchLimitExceeded",
        limit: 20,
        message: "GitHub batch cannot contain more than 20 pull requests",
      },
    })
    expect(calls).toBe(0)
  })

  test("preserves a failed process classification when its stdout is not a valid partial response", async () => {
    const cause = Object.assign(new Error("gh failed"), { stdout: JSON.stringify({ message: "Bad credentials" }) })
    const client = createGitHubClient(async () => {
      throw cause
    })

    expect(await client.get([pullRequest])).toEqual({
      ok: false,
      error: {
        tag: "GitHubUnavailable",
        message: "GitHub status unavailable",
        cause,
      },
    })
  })

  test("treats a null status rollup as no checks", async () => {
    const client = createGitHubClient(runnerFor(batchResponse(response({ statusCheckRollup: null }))))

    expect((await getOne(client)).state).toEqual({
      tag: "Open",
      ci: "none",
      mergeability: "mergeable",
      blocker: "none",
    })
  })

  test("renders an unavailable status without a diagnostic", () => {
    expect(statusAppearance({ tag: "Unavailable" })).toEqual({
      tone: "gray",
      label: "status unavailable",
      strikethrough: false,
    })
  })

  test.each([
    { diagnostic: "GitHubCliMissing" as const, label: "install gh" },
    { diagnostic: "GitHubAuthenticationRequired" as const, label: "run gh auth login" },
    { diagnostic: "GitHubUnavailable" as const, label: "GitHub unavailable" },
    { diagnostic: "InvalidGitHubResponse" as const, label: "invalid GitHub response" },
  ])("renders $diagnostic as $label when status is unavailable", ({ diagnostic, label }) => {
    expect(statusAppearance({ tag: "Unavailable", diagnostic })).toEqual({
      tone: "gray",
      label,
      strikethrough: false,
    })
  })

  test.each([
    { diagnostic: "GitHubCliMissing" as const, label: "checks pending (stale; install gh)" },
    {
      diagnostic: "GitHubAuthenticationRequired" as const,
      label: "checks pending (stale; run gh auth login)",
    },
    { diagnostic: "GitHubUnavailable" as const, label: "checks pending (stale; GitHub unavailable)" },
    {
      diagnostic: "InvalidGitHubResponse" as const,
      label: "checks pending (stale; invalid GitHub response)",
    },
  ])("renders $diagnostic as $label when status is stale", ({ diagnostic, label }) => {
    expect(
      statusAppearance({
        tag: "Available",
        pullRequest,
        title: "Title",
        state: { tag: "Open", ci: "pending", mergeability: "mergeable", blocker: "none" },
        stale: true,
        diagnostic,
      }),
    ).toEqual({ tone: "yellow", label, strikethrough: false })
  })

  test("renders a stale merge conflict with its diagnostic", () => {
    expect(
      statusAppearance({
        tag: "Available",
        pullRequest,
        title: "Title",
        state: { tag: "Open", ci: "pending", mergeability: "conflicting", blocker: "none" },
        stale: true,
        diagnostic: "GitHubUnavailable",
      }),
    ).toEqual({ tone: "red", label: "merge conflict (stale; GitHub unavailable)", strikethrough: false })
  })
})
