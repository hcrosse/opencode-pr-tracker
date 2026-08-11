import { describe, expect, test } from "bun:test"

import { createGitHubClient, statusAppearance, type GitHubClient, type ProcessRunner } from "../src/github.js"
import { parsePullRequestUrl } from "../src/url.js"

const parsed = parsePullRequestUrl("https://github.com/owner/repository/pull/42")
if (!parsed.ok) throw new Error("test fixture URL is invalid")
const pullRequest = parsed.value
const secondParsed = parsePullRequestUrl("https://github.com/another/project/pull/7")
if (!secondParsed.ok) throw new Error("second test fixture URL is invalid")
const secondPullRequest = secondParsed.value
const successCounts = { checkRuns: [{ state: "SUCCESS", count: 1 }] }
const pendingCounts = { checkRuns: [{ state: "IN_PROGRESS", count: 1 }] }
const failedCounts = { checkRuns: [{ state: "FAILURE", count: 1 }] }
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
    statusCheckRollup: rollup(),
    ...overrides,
  }
}

function rollup(
  input: Readonly<{
    checkRuns?: readonly Readonly<{ state: string; count: number }>[]
    statusContexts?: readonly Readonly<{ state: string; count: number }>[]
    overrides?: Record<string, unknown>
  }> = {},
): Record<string, unknown> {
  const checkRuns = input.checkRuns ?? []
  const statusContexts = input.statusContexts ?? []
  return {
    contexts: {
      checkRunCount: checkRuns.reduce((total, item) => total + item.count, 0),
      statusContextCount: statusContexts.reduce((total, item) => total + item.count, 0),
      checkRunCountsByState: checkRuns,
      statusContextCountsByState: statusContexts,
      ...input.overrides,
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
    expect(calls[0]?.args[5]).toContain("title state url mergedAt mergeable statusCheckRollup")
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
    { name: "no checks", counts: {}, expected: "none" },
    {
      name: "successful check run",
      counts: successCounts,
      expected: "passed",
    },
    {
      name: "successful status context",
      counts: { statusContexts: [{ state: "SUCCESS", count: 1 }] },
      expected: "passed",
    },
    {
      name: "pending check",
      counts: pendingCounts,
      expected: "pending",
    },
    {
      name: "pending status context",
      counts: { statusContexts: [{ state: "PENDING", count: 1 }] },
      expected: "pending",
    },
    {
      name: "failure wins over pending",
      counts: {
        checkRuns: [
          { state: "IN_PROGRESS", count: 1 },
          { state: "FAILURE", count: 1 },
        ],
      },
      expected: "failed",
    },
    {
      name: "error status fails",
      counts: { statusContexts: [{ state: "ERROR", count: 1 }] },
      expected: "failed",
    },
    {
      name: "neutral and skipped checks are absent",
      counts: {
        checkRuns: [
          { state: "NEUTRAL", count: 1 },
          { state: "SKIPPED", count: 1 },
        ],
      },
      expected: "none",
    },
  ])("aggregates $name", async ({ counts, expected }) => {
    const client = createGitHubClient(runnerFor(batchResponse(response({ statusCheckRollup: rollup(counts) }))))

    expect((await getOne(client)).state).toEqual({ tag: "Open", ci: expected, mergeability: "mergeable" })
  })

  test.each([
    { raw: "MERGEABLE", expected: "mergeable" },
    { raw: "CONFLICTING", expected: "conflicting" },
    { raw: "UNKNOWN", expected: "unknown" },
  ])("parses $raw mergeability", async ({ raw, expected }) => {
    const client = createGitHubClient(runnerFor(batchResponse(response({ mergeable: raw }))))

    expect((await getOne(client)).state).toEqual({ tag: "Open", ci: "none", mergeability: expected })
  })

  test.each([
    {
      state: "MERGED",
      mergedAt: "2026-08-10T12:00:00Z",
      counts: {},
      tone: "purple",
      label: "merged",
      strike: true,
    },
    { state: "CLOSED", mergedAt: null, counts: {}, tone: "red", label: "closed", strike: true },
    { state: "OPEN", mergedAt: null, counts: {}, tone: "gray", label: "no checks", strike: false },
    {
      state: "OPEN",
      mergedAt: null,
      counts: successCounts,
      tone: "green",
      label: "checks passed",
      strike: false,
    },
    {
      state: "OPEN",
      mergedAt: null,
      counts: pendingCounts,
      tone: "yellow",
      label: "checks pending",
      strike: false,
    },
    {
      state: "OPEN",
      mergedAt: null,
      counts: failedCounts,
      tone: "red",
      label: "checks failed",
      strike: false,
    },
  ])("projects $state status with $label appearance", async ({ state, mergedAt, counts, tone, label, strike }) => {
    const client = createGitHubClient(
      runnerFor(batchResponse(response({ state, mergedAt, statusCheckRollup: rollup(counts) }))),
    )

    expect(statusAppearance(await getOne(client))).toEqual({ tone, label, strikethrough: strike })
  })

  test("gives an open merge conflict precedence over CI", async () => {
    const client = createGitHubClient(
      runnerFor(batchResponse(response({ mergeable: "CONFLICTING", statusCheckRollup: rollup(successCounts) }))),
    )

    expect(statusAppearance(await getOne(client))).toEqual({
      tone: "red",
      label: "merge conflict",
      strikethrough: false,
    })
  })

  test("uses CI while GitHub computes mergeability", async () => {
    const client = createGitHubClient(
      runnerFor(batchResponse(response({ mergeable: "UNKNOWN", statusCheckRollup: rollup(pendingCounts) }))),
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
      runnerFor(batchResponse(response({ state, mergedAt, statusCheckRollup: rollup(failedCounts) }))),
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
    response({ statusCheckRollup: rollup({ checkRuns: [{ state: "UNKNOWN", count: 1 }] }) }),
    response({
      state: "MERGED",
      mergedAt: "2026-08-10T12:00:00Z",
      statusCheckRollup: rollup({ checkRuns: [{ state: "UNKNOWN", count: 1 }] }),
    }),
    response({
      state: "CLOSED",
      statusCheckRollup: rollup({ checkRuns: [{ state: "UNKNOWN", count: 1 }] }),
    }),
    response({ url: "https://example.com/owner/repository/pull/42" }),
    response({ statusCheckRollup: rollup({ overrides: { checkRunCount: 1 } }) }),
    response({ mergeable: "BLOCKED" }),
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

    expect((await getOne(client)).state).toEqual({ tag: "Open", ci: "none", mergeability: "mergeable" })
  })

  test("marks stale and unavailable status appearances", () => {
    expect(
      statusAppearance({
        tag: "Available",
        pullRequest,
        title: "Title",
        state: { tag: "Open", ci: "pending", mergeability: "conflicting" },
        stale: true,
      }),
    ).toEqual({ tone: "red", label: "merge conflict (stale)", strikethrough: false })
    expect(statusAppearance({ tag: "Unavailable" })).toEqual({
      tone: "gray",
      label: "status unavailable",
      strikethrough: false,
    })
  })
})
