import { describe, expect, test } from "bun:test"

import { createGitHubClient, statusAppearance, type ProcessRunner } from "../src/github.js"
import { parsePullRequestUrl } from "../src/url.js"

const parsed = parsePullRequestUrl("https://github.com/owner/repository/pull/42")
if (!parsed.ok) throw new Error("test fixture URL is invalid")
const pullRequest = parsed.value
const successChecks = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }]
const pendingChecks = [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }]
const failedChecks = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }]

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
    title: "Add pull request tracking",
    state: "OPEN",
    url: pullRequest.url,
    mergedAt: null,
    statusCheckRollup: [],
    ...overrides,
  }
}

describe("GitHub client", () => {
  test("uses a fixed gh argument vector and propagates cancellation", async () => {
    const calls: Array<{ file: string; args: readonly string[]; signal?: AbortSignal }> = []
    const client = createGitHubClient(runnerFor(response(), calls))
    const controller = new AbortController()

    await client.get(pullRequest, { signal: controller.signal })

    expect(calls).toEqual([
      {
        file: "gh",
        args: ["pr", "view", pullRequest.url, "--json", "title,state,url,mergedAt,statusCheckRollup"],
        signal: controller.signal,
      },
    ])
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

    const request = client.get(pullRequest, { signal: controller.signal })
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
    const client = createGitHubClient(runnerFor(response({ statusCheckRollup: checks })))

    const result = await client.get(pullRequest)

    if (!result.ok) throw new Error("expected GitHub response to parse")
    expect(result.value.state).toEqual({ tag: "Open", ci: expected })
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
    const client = createGitHubClient(runnerFor(response({ state, mergedAt, statusCheckRollup: checks })))

    const result = await client.get(pullRequest)

    if (!result.ok) throw new Error("expected GitHub response to parse")
    expect(statusAppearance(result.value)).toEqual({ tone, label, strikethrough: strike })
  })

  test.each([
    { state: "MERGED", mergedAt: "2026-08-10T12:00:00Z", expected: { tag: "Merged" } },
    { state: "CLOSED", mergedAt: null, expected: { tag: "Closed" } },
  ])("accepts valid checks without retaining CI for $state pull requests", async ({ state, mergedAt, expected }) => {
    const client = createGitHubClient(runnerFor(response({ state, mergedAt, statusCheckRollup: failedChecks })))

    const result = await client.get(pullRequest)

    if (!result.ok) throw new Error("expected GitHub response to parse")
    expect(result.value.state).toEqual(expected)
  })

  test("classifies execution failures without exposing credentials", async () => {
    const cause = new Error("gh auth token secret")
    const client = createGitHubClient(async () => {
      throw cause
    })

    expect(await client.get(pullRequest)).toEqual({
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
    JSON.stringify(response({ state: "UNKNOWN" })),
    JSON.stringify(response({ state: "CLOSED", mergedAt: "2026-08-10T12:00:00Z" })),
    JSON.stringify(
      response({ statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "UNKNOWN" }] }),
    ),
    JSON.stringify(
      response({
        state: "MERGED",
        mergedAt: "2026-08-10T12:00:00Z",
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "UNKNOWN" }],
      }),
    ),
    JSON.stringify(
      response({
        state: "CLOSED",
        statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "UNKNOWN" }],
      }),
    ),
    JSON.stringify(response({ url: "https://example.com/owner/repository/pull/42" })),
  ])("rejects malformed gh output", async (stdout) => {
    const client = createGitHubClient(async () => ({ stdout }))

    expect(await client.get(pullRequest)).toEqual({
      ok: false,
      error: {
        tag: "InvalidGitHubResponse",
        message: "GitHub returned an invalid pull request response",
      },
    })
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
