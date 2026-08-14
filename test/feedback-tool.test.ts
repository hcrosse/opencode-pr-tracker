import { describe, expect, test } from "bun:test"

import { tool, type ToolContext } from "@opencode-ai/plugin"

import { createFeedbackTool, FeedbackToolError } from "../src/feedback-tool.js"
import type { FeedbackDiagnostics } from "../src/feedback.js"
import type { ProcessRunner } from "../src/github.js"

const diagnostics: FeedbackDiagnostics = {
  pluginVersion: "0.3.0",
  opencodeVersion: "1.18.15",
  operatingSystem: "darwin/arm64",
}

const bugFeedback = {
  kind: "bug" as const,
  title: "Sidebar status is stale",
  problem: "The sidebar does not update.",
  reproduction: "Attach a pull request, then open the sidebar.",
  expected_behavior: "The current status appears.",
}

function context(): ToolContext {
  return {
    sessionID: "session",
    messageID: "message",
    agent: "build",
    directory: "/project",
    worktree: "/project",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  }
}

function createHarness(
  options: Readonly<{
    runner?: ProcessRunner
    now?: () => number
    readDiagnostics?: (signal: AbortSignal) => Promise<FeedbackDiagnostics>
  }> = {},
) {
  const processCalls: Array<{ file: string; args: readonly string[]; signal?: AbortSignal }> = []
  let diagnosticsCalls = 0
  const runner: ProcessRunner = async (file, args, runnerOptions) => {
    processCalls.push({ file, args, ...(runnerOptions?.signal === undefined ? {} : { signal: runnerOptions.signal }) })
    return options.runner?.(file, args, runnerOptions) ?? { stdout: "" }
  }
  const feedbackTool = createFeedbackTool({
    createPreviewID: () => "preview-1",
    ...(options.now === undefined ? {} : { now: options.now }),
    async readDiagnostics(signal) {
      diagnosticsCalls += 1
      if (options.readDiagnostics !== undefined) return options.readDiagnostics(signal)
      expect(signal).toBe(contextSignal)
      return diagnostics
    },
    platform: "darwin",
    runner,
  })
  const toolContext = context()
  const contextSignal = toolContext.abort
  return { feedbackTool, toolContext, processCalls, diagnosticsCalls: () => diagnosticsCalls }
}

function expectString(value: Awaited<ReturnType<ReturnType<typeof createFeedbackTool>["execute"]>>): string {
  expect(value).toBeString()
  if (typeof value !== "string") throw new Error("expected string tool output")
  return value
}

describe("pr_feedback tool", () => {
  test("previews the exact bug template and opted-in diagnostics without delivery", async () => {
    const harness = createHarness()

    const output = await harness.feedbackTool.execute(
      {
        request: {
          action: "preview",
          feedback: bugFeedback,
          include_diagnostics: true,
        },
      },
      harness.toolContext,
    )

    expect(output).toBe(
      [
        "Feedback preview (not submitted)",
        "",
        "Title: Sidebar status is stale",
        "Label: bug",
        "",
        "Body:",
        "## Problem",
        "",
        "The sidebar does not update.",
        "",
        "## Reproduction",
        "",
        "Attach a pull request, then open the sidebar.",
        "",
        "## Expected Behavior",
        "",
        "The current status appears.",
        "",
        "## Environment",
        "",
        "- OpenCode version: 1.18.15",
        "- Plugin version or commit: 0.3.0",
        "- Operating system: darwin/arm64",
        "",
        "Preview ID: preview-1",
      ].join("\n"),
    )
    expect(harness.diagnosticsCalls()).toBe(1)
    expect(harness.processCalls).toEqual([])
  })

  test("omits diagnostics without reading them", async () => {
    const harness = createHarness()

    const output = await harness.feedbackTool.execute(
      {
        request: {
          action: "preview",
          feedback: { kind: "other", title: "Documentation feedback", details: "The guide is clear." },
          include_diagnostics: false,
        },
      },
      harness.toolContext,
    )

    expect(output).not.toContain("## Diagnostics")
    expect(harness.diagnosticsCalls()).toBe(0)
  })

  test("opens approved browser feedback and returns the prefilled URL", async () => {
    const harness = createHarness()
    await harness.feedbackTool.execute(
      { request: { action: "preview", feedback: bugFeedback, include_diagnostics: false } },
      harness.toolContext,
    )

    const output = await harness.feedbackTool.execute(
      {
        request: {
          action: "deliver",
          preview_id: "preview-1",
          delivery: "browser",
          approval: "approved_via_question",
        },
      },
      harness.toolContext,
    )

    const urlString = expectString(output)
    const url = new URL(urlString)
    expect(url.origin + url.pathname).toBe("https://github.com/hcrosse/opencode-pr-tracker/issues/new")
    expect(url.searchParams.get("title")).toBe("Sidebar status is stale")
    expect(harness.processCalls).toEqual([{ file: "open", args: [urlString], signal: harness.toolContext.abort }])
  })

  test("submits approved GitHub CLI feedback and returns the created issue URL", async () => {
    const issueUrl = "https://github.com/hcrosse/opencode-pr-tracker/issues/95"
    const harness = createHarness({ runner: async () => ({ stdout: `${issueUrl}\n` }) })
    await harness.feedbackTool.execute(
      {
        request: {
          action: "preview",
          feedback: {
            kind: "feature",
            title: "Filter pull requests",
            problem: "Large sessions are difficult to scan.",
            desired_outcome: "Users can filter by repository.",
            constraints: "Keep keyboard navigation.",
          },
          include_diagnostics: false,
        },
      },
      harness.toolContext,
    )

    const output = await harness.feedbackTool.execute(
      {
        request: {
          action: "deliver",
          preview_id: "preview-1",
          delivery: "github_cli",
          approval: "approved_via_question",
        },
      },
      harness.toolContext,
    )

    expect(output).toBe(issueUrl)
    expect(harness.processCalls[0]).toMatchObject({
      file: "gh",
      args: [
        "issue",
        "create",
        "--repo",
        "hcrosse/opencode-pr-tracker",
        "--title",
        "Filter pull requests",
        "--body",
        [
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
          "Keep keyboard navigation.",
        ].join("\n"),
        "--label",
        "enhancement",
      ],
      signal: harness.toolContext.abort,
    })
  })

  test("warns that invalid GitHub CLI output may still have created the issue", async () => {
    const harness = createHarness({ runner: async () => ({ stdout: "created with warning" }) })
    await harness.feedbackTool.execute(
      { request: { action: "preview", feedback: bugFeedback, include_diagnostics: false } },
      harness.toolContext,
    )

    expect(
      harness.feedbackTool.execute(
        {
          request: {
            action: "deliver",
            preview_id: "preview-1",
            delivery: "github_cli",
            approval: "approved_via_question",
          },
        },
        harness.toolContext,
      ),
    ).rejects.toEqual(
      new FeedbackToolError(
        "InvalidGitHubResponse",
        "GitHub CLI may have created the issue but did not return a valid URL. Verify GitHub before previewing and approving a retry.",
      ),
    )
  })

  test("advertises template guidance and question-tool approval", () => {
    const { feedbackTool } = createHarness()

    expect(feedbackTool.description).toContain("OpenCode question tool")
    expect(feedbackTool.description).toContain("ISSUE_TEMPLATE/bug_report.md")
    expect(feedbackTool.description).toContain("ISSUE_TEMPLATE/feature_request.md")
    expect(feedbackTool.description).toContain("Never include session messages")
  })

  test("requires the approval literal and kind-specific fields", () => {
    const { feedbackTool } = createHarness()
    const schema = tool.schema.object(feedbackTool.args)

    expect(
      schema.safeParse({
        request: {
          action: "deliver",
          preview_id: "preview-1",
          delivery: "browser",
        },
      }).success,
    ).toBe(false)
    expect(
      schema.safeParse({
        request: {
          action: "preview",
          feedback: { ...bugFeedback, desired_outcome: "Wrong template field" },
          include_diagnostics: false,
        },
      }).success,
    ).toBe(false)
  })

  test("translates delivery failures into a structured tool error", async () => {
    const harness = createHarness({
      runner: async () => {
        throw new Error("open failed")
      },
    })
    await harness.feedbackTool.execute(
      { request: { action: "preview", feedback: bugFeedback, include_diagnostics: false } },
      harness.toolContext,
    )

    expect(
      harness.feedbackTool.execute(
        {
          request: {
            action: "deliver",
            preview_id: "preview-1",
            delivery: "browser",
            approval: "approved_via_question",
          },
        },
        harness.toolContext,
      ),
    ).rejects.toEqual(
      new FeedbackToolError(
        "OpenFeedbackFailed",
        "Unable to open feedback; choose GitHub CLI delivery or retry. Preview and approve again before retry.",
      ),
    )
  })

  test("rejects missing, cross-session, and reused previews", async () => {
    const harness = createHarness()
    await harness.feedbackTool.execute(
      { request: { action: "preview", feedback: bugFeedback, include_diagnostics: false } },
      harness.toolContext,
    )
    const otherSession = { ...harness.toolContext, sessionID: "other-session" }

    expect(
      harness.feedbackTool.execute(
        {
          request: {
            action: "deliver",
            preview_id: "preview-1",
            delivery: "browser",
            approval: "approved_via_question",
          },
        },
        otherSession,
      ),
    ).rejects.toEqual(new FeedbackToolError("FeedbackPreviewNotFound", "Preview feedback again before delivery"))

    await harness.feedbackTool.execute(
      {
        request: {
          action: "deliver",
          preview_id: "preview-1",
          delivery: "browser",
          approval: "approved_via_question",
        },
      },
      harness.toolContext,
    )
    expect(
      harness.feedbackTool.execute(
        {
          request: {
            action: "deliver",
            preview_id: "preview-1",
            delivery: "browser",
            approval: "approved_via_question",
          },
        },
        harness.toolContext,
      ),
    ).rejects.toEqual(new FeedbackToolError("FeedbackPreviewNotFound", "Preview feedback again before delivery"))
  })

  test("expires previews and clears them with their session", async () => {
    let now = 0
    const harness = createHarness({ now: () => now })
    await harness.feedbackTool.execute(
      { request: { action: "preview", feedback: bugFeedback, include_diagnostics: false } },
      harness.toolContext,
    )
    now = 15 * 60 * 1_000 + 1

    expect(
      harness.feedbackTool.execute(
        {
          request: {
            action: "deliver",
            preview_id: "preview-1",
            delivery: "browser",
            approval: "approved_via_question",
          },
        },
        harness.toolContext,
      ),
    ).rejects.toEqual(new FeedbackToolError("FeedbackPreviewNotFound", "Preview feedback again before delivery"))

    await harness.feedbackTool.execute(
      { request: { action: "preview", feedback: bugFeedback, include_diagnostics: false } },
      harness.toolContext,
    )
    harness.feedbackTool.clearSession(harness.toolContext.sessionID)
    expect(
      harness.feedbackTool.execute(
        {
          request: {
            action: "deliver",
            preview_id: "preview-1",
            delivery: "browser",
            approval: "approved_via_question",
          },
        },
        harness.toolContext,
      ),
    ).rejects.toEqual(new FeedbackToolError("FeedbackPreviewNotFound", "Preview feedback again before delivery"))
  })

  test("does not retain a preview completed after its session is cleared", async () => {
    let resolveDiagnostics: ((value: FeedbackDiagnostics) => void) | undefined
    const harness = createHarness({
      readDiagnostics: () =>
        new Promise((resolve) => {
          resolveDiagnostics = resolve
        }),
    })
    const preview = harness.feedbackTool.execute(
      { request: { action: "preview", feedback: bugFeedback, include_diagnostics: true } },
      harness.toolContext,
    )
    await Bun.sleep(0)
    harness.feedbackTool.clearSession(harness.toolContext.sessionID)
    resolveDiagnostics?.(diagnostics)

    expect(preview).rejects.toEqual(
      new FeedbackToolError("FeedbackPreviewNotFound", "Preview feedback again before delivery"),
    )
  })
})
