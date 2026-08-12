import { describe, expect, test } from "bun:test"

import {
  createFeedbackDraft,
  createFeedbackIssueUrl,
  type FeedbackDiagnostics,
  type FeedbackDraft,
  type FeedbackInput,
  type FeedbackKind,
} from "../src/feedback.js"

const diagnostics: FeedbackDiagnostics = {
  pluginVersion: " 0.3.0 ",
  opencodeVersion: " 1.18.15 ",
  operatingSystem: " macOS 15.6 ",
  installationSource: " npm ",
}

function expectDraft(result: ReturnType<typeof createFeedbackDraft>): FeedbackDraft {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error("expected feedback draft")
  return result.value
}

describe("createFeedbackDraft", () => {
  test("formats a bug report", () => {
    const kind: FeedbackKind = "bug"
    const input: FeedbackInput = {
      kind,
      title: " Sidebar status is stale ",
      problem: " The sidebar does not update. ",
      reproduction: " 1. Attach a pull request.\n2. Open the sidebar. ",
      expectedBehavior: " The current status appears. ",
    }

    expect(expectDraft(createFeedbackDraft(input))).toEqual({
      title: "Sidebar status is stale",
      body: [
        "## Problem",
        "",
        "The sidebar does not update.",
        "",
        "## Reproduction",
        "",
        "1. Attach a pull request.\n2. Open the sidebar.",
        "",
        "## Expected Behavior",
        "",
        "The current status appears.",
      ].join("\n"),
      label: "bug",
      template: "bug_report.md",
    })
  })

  test("formats a feature request with constraints", () => {
    const input: FeedbackInput = {
      kind: "feature",
      title: " Filter attached pull requests ",
      problem: " Large sessions are difficult to scan. ",
      desiredOutcome: " Users can filter by repository. ",
      constraints: " Keep keyboard navigation available. ",
    }

    expect(expectDraft(createFeedbackDraft(input))).toEqual({
      title: "Filter attached pull requests",
      body: [
        "## Problem",
        "",
        "Large sessions are difficult to scan.",
        "",
        "## Desired Outcome",
        "",
        "Users can filter by repository.",
        "",
        "## Constraints",
        "",
        "Keep keyboard navigation available.",
      ].join("\n"),
      label: "enhancement",
      template: "feature_request.md",
    })
  })

  test("omits blank feature constraints", () => {
    const input: FeedbackInput = {
      kind: "feature",
      title: "Filter attached pull requests",
      problem: "Large sessions are difficult to scan.",
      desiredOutcome: "Users can filter by repository.",
      constraints: " \n\t ",
    }

    expect(expectDraft(createFeedbackDraft(input))).toEqual({
      title: "Filter attached pull requests",
      body: [
        "## Problem",
        "",
        "Large sessions are difficult to scan.",
        "",
        "## Desired Outcome",
        "",
        "Users can filter by repository.",
      ].join("\n"),
      label: "enhancement",
      template: "feature_request.md",
    })
  })

  test("formats other feedback without a label or template", () => {
    const input: FeedbackInput = {
      kind: "other",
      title: " Documentation feedback ",
      details: " The installation guide is clear. ",
    }

    expect(expectDraft(createFeedbackDraft(input))).toEqual({
      title: "Documentation feedback",
      body: "## Details\n\nThe installation guide is clear.",
    })
  })

  test.each([
    {
      input: { kind: "bug", title: " ", problem: "problem", reproduction: "steps", expectedBehavior: "expected" },
      field: "title",
    },
    {
      input: { kind: "bug", title: "title", problem: "\n", reproduction: "steps", expectedBehavior: "expected" },
      field: "problem",
    },
    {
      input: { kind: "bug", title: "title", problem: "problem", reproduction: "\t", expectedBehavior: "expected" },
      field: "reproduction",
    },
    {
      input: { kind: "bug", title: "title", problem: "problem", reproduction: "steps", expectedBehavior: " " },
      field: "expectedBehavior",
    },
    { input: { kind: "feature", title: " ", problem: "problem", desiredOutcome: "outcome" }, field: "title" },
    { input: { kind: "feature", title: "title", problem: "\n", desiredOutcome: "outcome" }, field: "problem" },
    { input: { kind: "feature", title: "title", problem: "problem", desiredOutcome: "\t" }, field: "desiredOutcome" },
    { input: { kind: "other", title: " ", details: "details" }, field: "title" },
    { input: { kind: "other", title: "title", details: "\n" }, field: "details" },
  ] satisfies readonly { input: FeedbackInput; field: string }[])(
    "rejects a blank $field field",
    ({ input, field }) => {
      expect(createFeedbackDraft(input)).toEqual({
        ok: false,
        error: { tag: "InvalidFeedback", message: `${field} must not be empty` },
      })
    },
  )

  test("appends supplied diagnostics with fixed keys", () => {
    const input: FeedbackInput = {
      kind: "other",
      title: "Diagnostic context",
      details: "The command exits without opening GitHub.",
    }

    expect(expectDraft(createFeedbackDraft(input, diagnostics))).toEqual({
      title: "Diagnostic context",
      body: [
        "## Details",
        "",
        "The command exits without opening GitHub.",
        "",
        "## Diagnostics",
        "",
        "- Plugin version: 0.3.0",
        "- OpenCode version: 1.18.15",
        "- Operating system: macOS 15.6",
        "- Installation source: npm",
      ].join("\n"),
    })
  })

  test.each([
    { diagnostics: { ...diagnostics, pluginVersion: " " }, field: "pluginVersion" },
    { diagnostics: { ...diagnostics, opencodeVersion: "\n" }, field: "opencodeVersion" },
    { diagnostics: { ...diagnostics, operatingSystem: "\t" }, field: "operatingSystem" },
    { diagnostics: { ...diagnostics, installationSource: " " }, field: "installationSource" },
  ])("rejects a blank diagnostic $field field", ({ diagnostics: invalidDiagnostics, field }) => {
    const input: FeedbackInput = {
      kind: "other",
      title: "Diagnostic context",
      details: "The command exits without opening GitHub.",
    }

    expect(createFeedbackDraft(input, invalidDiagnostics)).toEqual({
      ok: false,
      error: { tag: "InvalidFeedback", message: `${field} must not be empty` },
    })
  })

  test("preserves a pull request URL explicitly entered by the user", () => {
    const pullRequestUrl = "https://github.com/hcrosse/opencode-pr-tracker/pull/78"
    const input: FeedbackInput = {
      kind: "other",
      title: "Pull request feedback",
      details: `This happened after I opened ${pullRequestUrl}.`,
    }

    expect(expectDraft(createFeedbackDraft(input)).body).toContain(pullRequestUrl)
  })

  test("excludes automatic session and attachment input from the feedback contract", () => {
    type ExcludesSessionInput = [Extract<FeedbackInput, Readonly<{ sessionID: unknown }>>] extends [never]
      ? true
      : false
    type ExcludesAttachmentInput = [Extract<FeedbackInput, Readonly<{ attachments: unknown }>>] extends [never]
      ? true
      : false

    const excludesSessionInput: ExcludesSessionInput = true
    const excludesAttachmentInput: ExcludesAttachmentInput = true

    expect(excludesSessionInput).toBe(true)
    expect(excludesAttachmentInput).toBe(true)
  })
})

describe("createFeedbackIssueUrl", () => {
  test("creates a prefilled bug report URL", () => {
    const draft = expectDraft(
      createFeedbackDraft({
        kind: "bug",
        title: "Sidebar status is stale",
        problem: "The sidebar does not update.",
        reproduction: "Attach a pull request, then open the sidebar.",
        expectedBehavior: "The current status appears.",
      }),
    )

    const url = new URL(createFeedbackIssueUrl(draft))
    if (draft.label === undefined || draft.template === undefined) {
      throw new Error("expected bug draft metadata")
    }

    expect(url.origin + url.pathname).toBe("https://github.com/hcrosse/opencode-pr-tracker/issues/new")
    expect(url.searchParams.get("title")).toBe(draft.title)
    expect(url.searchParams.get("body")).toBe(draft.body)
    expect(url.searchParams.get("labels")).toBe(draft.label)
    expect(url.searchParams.get("template")).toBe(draft.template)
    expect([...url.searchParams.keys()]).toEqual(["title", "body", "labels", "template"])
  })

  test("omits label and template parameters when the draft has neither", () => {
    const draft = expectDraft(
      createFeedbackDraft({
        kind: "other",
        title: "Documentation feedback",
        details: "The installation guide is clear.",
      }),
    )

    const url = new URL(createFeedbackIssueUrl(draft))

    expect(url.searchParams.get("title")).toBe(draft.title)
    expect(url.searchParams.get("body")).toBe(draft.body)
    expect(url.searchParams.has("labels")).toBe(false)
    expect(url.searchParams.has("template")).toBe(false)
    expect([...url.searchParams.keys()]).toEqual(["title", "body"])
  })
})
