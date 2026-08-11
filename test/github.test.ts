import { describe, expect, test } from "bun:test"

import { createGitHubClient, statusAppearance, type GitHubClient, type ProcessRunner } from "../src/github.js"
import { parsePullRequestUrl } from "../src/url.js"

const parsed = parsePullRequestUrl("https://github.com/owner/repository/pull/42")
if (!parsed.ok) throw new Error("test fixture URL is invalid")
const pullRequest = parsed.value
const secondParsed = parsePullRequestUrl("https://github.com/another/project/pull/7")
if (!secondParsed.ok) throw new Error("second test fixture URL is invalid")
const secondPullRequest = secondParsed.value
const successChecks = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }]
const pendingChecks = [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }]
const failedChecks = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }]
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
    statusCheckRollup: rollup(),
    ...overrides,
  }
}

function rollup(nodes: readonly unknown[] = [], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const checkRunStates = new Map<string, number>()
  const statusContextStates = new Map<string, number>()
  for (const node of nodes) {
    if (node === null || typeof node !== "object" || Array.isArray(node) || !("__typename" in node)) continue
    if (node.__typename === "CheckRun" && "status" in node && "conclusion" in node) {
      const state = node.status === "COMPLETED" ? node.conclusion : node.status
      if (typeof state === "string") checkRunStates.set(state, (checkRunStates.get(state) ?? 0) + 1)
    }
    if (node.__typename === "StatusContext" && "state" in node && typeof node.state === "string") {
      statusContextStates.set(node.state, (statusContextStates.get(node.state) ?? 0) + 1)
    }
  }
  return {
    contexts: {
      checkRunCount: [...checkRunStates.values()].reduce((total, count) => total + count, 0),
      statusContextCount: [...statusContextStates.values()].reduce((total, count) => total + count, 0),
      checkRunCountsByState: [...checkRunStates].map(([state, count]) => ({ state, count })),
      statusContextCountsByState: [...statusContextStates].map(([state, count]) => ({ state, count })),
      ...overrides,
    },
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
    expect(calls[0]?.args[5]).toContain("checkRunCountsByState { state count }")
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

  test.each([
    { name: "no checks", checks: [], expected: "none" },
    {
      name: "successful check run",
      checks: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      expected: "passed",
    },
    {
      name: "successful status context",
      checks: [{ __typename: "StatusContext", state: "SUCCESS" }],
      expected: "passed",
    },
    {
      name: "pending check",
      checks: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }],
      expected: "pending",
    },
    {
      name: "pending status context",
      checks: [{ __typename: "StatusContext", state: "PENDING" }],
      expected: "pending",
    },
    {
      name: "failure wins over pending",
      checks: [
        { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
      ],
      expected: "failed",
    },
    {
      name: "error status fails",
      checks: [{ __typename: "StatusContext", state: "ERROR" }],
      expected: "failed",
    },
    {
      name: "neutral and skipped checks are absent",
      checks: [
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "NEUTRAL" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
      ],
      expected: "none",
    },
  ])("aggregates $name", async ({ checks, expected }) => {
    const client = createGitHubClient(runnerFor(batchResponse(response({ statusCheckRollup: rollup(checks) }))))

    expect((await getOne(client)).state).toEqual({ tag: "Open", ci: expected })
  })

  test.each([
    {
      state: "MERGED",
      mergedAt: "2026-08-10T12:00:00Z",
      checks: [],
      tone: "purple",
      label: "merged",
      strike: true,
    },
    { state: "CLOSED", mergedAt: null, checks: [], tone: "red", label: "closed", strike: true },
    { state: "OPEN", mergedAt: null, checks: [], tone: "gray", label: "no checks", strike: false },
    {
      state: "OPEN",
      mergedAt: null,
      checks: successChecks,
      tone: "green",
      label: "checks passed",
      strike: false,
    },
    {
      state: "OPEN",
      mergedAt: null,
      checks: pendingChecks,
      tone: "yellow",
      label: "checks pending",
      strike: false,
    },
    {
      state: "OPEN",
      mergedAt: null,
      checks: failedChecks,
      tone: "red",
      label: "checks failed",
      strike: false,
    },
  ])("projects $state status with $label appearance", async ({ state, mergedAt, checks, tone, label, strike }) => {
    const client = createGitHubClient(
      runnerFor(batchResponse(response({ state, mergedAt, statusCheckRollup: rollup(checks) }))),
    )

    expect(statusAppearance(await getOne(client))).toEqual({ tone, label, strikethrough: strike })
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
    response({ statusCheckRollup: rollup([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "UNKNOWN" }]) }),
    response({
      state: "MERGED",
      mergedAt: "2026-08-10T12:00:00Z",
      statusCheckRollup: rollup([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "UNKNOWN" }]),
    }),
    response({
      state: "CLOSED",
      statusCheckRollup: rollup([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "UNKNOWN" }]),
    }),
    response({ url: "https://example.com/owner/repository/pull/42" }),
    response({ statusCheckRollup: rollup([], { checkRunCount: 1 }) }),
    response({ __typename: "Issue" }),
  ])("isolates malformed pull request data to its batch item", async (item) => {
    const client = createGitHubClient(runnerFor(batchResponse(item)))

    expect(await client.get([pullRequest])).toEqual({ ok: true, value: [invalidItem] })
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

    expect((await getOne(client)).state).toEqual({ tag: "Open", ci: "none" })
  })

  test("marks stale and unavailable status appearances", () => {
    expect(
      statusAppearance({
        tag: "Available",
        pullRequest,
        title: "Title",
        state: { tag: "Open", ci: "pending" },
        stale: true,
      }),
    ).toEqual({ tone: "yellow", label: "checks pending (stale)", strikethrough: false })
    expect(statusAppearance({ tag: "Unavailable" })).toEqual({
      tone: "gray",
      label: "status unavailable",
      strikethrough: false,
    })
  })
})
