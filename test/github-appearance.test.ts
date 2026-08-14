import { describe, expect, test } from "bun:test"

import { createGitHubClient, statusAppearance } from "../src/github.js"
import {
  baseRefPolicy,
  batchResponse,
  checkRun,
  getOne,
  pullRequest,
  response,
  rollup,
  runnerFor,
} from "./github-fixtures.js"

const successChecks = { nodes: [checkRun()] }
const pendingChecks = { nodes: [checkRun({ status: "IN_PROGRESS", conclusion: null })] }
const failedChecks = { nodes: [checkRun({ conclusion: "FAILURE" })] }

describe("GitHub client", () => {
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
    { contexts: {}, tone: "gray", label: "draft" },
    { contexts: successChecks, tone: "gray", label: "draft" },
    { contexts: pendingChecks, tone: "gray", label: "draft" },
    { contexts: failedChecks, tone: "red", label: "checks failed" },
  ])("renders draft pull request CI as $label", async ({ contexts, tone, label }) => {
    const client = createGitHubClient(
      runnerFor(batchResponse(response({ isDraft: true, statusCheckRollup: rollup(contexts) }))),
    )

    expect(statusAppearance(await getOne(client))).toEqual({ tone, label, strikethrough: false })
  })

  test("gives a draft merge conflict precedence over draft appearance", async () => {
    const client = createGitHubClient(runnerFor(batchResponse(response({ isDraft: true, mergeable: "CONFLICTING" }))))

    expect(statusAppearance(await getOne(client))).toEqual({
      tone: "red",
      label: "merge conflict",
      strikethrough: false,
    })
  })

  test("gives draft appearance precedence over a behind branch", async () => {
    const client = createGitHubClient(
      runnerFor(
        batchResponse(
          response({
            isDraft: true,
            mergeStateStatus: "BEHIND",
            baseRef: baseRefPolicy({
              branchProtectionRule: { requiresStatusChecks: true, requiresStrictStatusChecks: true },
            }),
          }),
        ),
      ),
    )

    expect(statusAppearance(await getOne(client))).toEqual({ tone: "gray", label: "draft", strikethrough: false })
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
        state: { tag: "Open", ci: "pending", isDraft: false, mergeability: "mergeable", blocker: "none" },
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
        state: { tag: "Open", ci: "pending", isDraft: false, mergeability: "conflicting", blocker: "none" },
        stale: true,
        diagnostic: "GitHubUnavailable",
      }),
    ).toEqual({ tone: "red", label: "merge conflict (stale; GitHub unavailable)", strikethrough: false })
  })
})
