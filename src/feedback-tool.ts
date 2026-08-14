import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { randomUUID } from "node:crypto"

import { casesHandled } from "./exhaustive.js"
import {
  createFeedbackDraft,
  createFeedbackIssueUrl,
  openFeedbackDraft,
  submitFeedbackDraft,
  type FeedbackDiagnostics,
  type FeedbackDraft,
  type FeedbackInput,
} from "./feedback.js"
import type { ProcessRunner } from "./github.js"

const bugFeedbackSchema = tool.schema
  .object({
    kind: tool.schema.literal("bug"),
    title: tool.schema.string(),
    problem: tool.schema.string(),
    reproduction: tool.schema.string(),
    expected_behavior: tool.schema.string(),
    relevant_output: tool.schema.string().optional(),
  })
  .strict()

const featureFeedbackSchema = tool.schema
  .object({
    kind: tool.schema.literal("feature"),
    title: tool.schema.string(),
    problem: tool.schema.string(),
    desired_outcome: tool.schema.string(),
    constraints: tool.schema.string().optional(),
  })
  .strict()

const otherFeedbackSchema = tool.schema
  .object({
    kind: tool.schema.literal("other"),
    title: tool.schema.string(),
    details: tool.schema.string(),
  })
  .strict()

const feedbackSchema = tool.schema.discriminatedUnion("kind", [
  bugFeedbackSchema,
  featureFeedbackSchema,
  otherFeedbackSchema,
])

const previewRequestSchema = tool.schema
  .object({
    action: tool.schema.literal("preview"),
    feedback: feedbackSchema,
    include_diagnostics: tool.schema.boolean(),
  })
  .strict()

const deliverRequestSchema = tool.schema
  .object({
    action: tool.schema.literal("deliver"),
    preview_id: tool.schema.string(),
    delivery: tool.schema.enum(["browser", "github_cli"]),
    approval: tool.schema.literal("approved_via_question"),
  })
  .strict()

const requestSchema = tool.schema.discriminatedUnion("action", [previewRequestSchema, deliverRequestSchema])

type FeedbackValue =
  | Readonly<{
      kind: "bug"
      title: string
      problem: string
      reproduction: string
      expected_behavior: string
      relevant_output?: string | undefined
    }>
  | Readonly<{
      kind: "feature"
      title: string
      problem: string
      desired_outcome: string
      constraints?: string | undefined
    }>
  | Readonly<{ kind: "other"; title: string; details: string }>

export type FeedbackToolErrorCode =
  | "InvalidFeedback"
  | "UnsupportedPlatform"
  | "FeedbackUrlTooLong"
  | "OpenFeedbackFailed"
  | "OpenFeedbackCancelled"
  | "GitHubCliMissing"
  | "GitHubAuthenticationRequired"
  | "SubmitFeedbackCancelled"
  | "InvalidGitHubResponse"
  | "SubmitFeedbackFailed"
  | "FeedbackPreviewNotFound"

export class FeedbackToolError extends Error {
  override readonly name = "FeedbackToolError"

  constructor(
    readonly code: FeedbackToolErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type FeedbackToolDependencies = Readonly<{
  readDiagnostics(signal: AbortSignal): Promise<FeedbackDiagnostics>
  createPreviewID?: () => string
  now?: () => number
  platform?: string
  runner?: ProcessRunner
}>

export type FeedbackTool = ToolDefinition & Readonly<{ clearSession(sessionID: string): void }>

function toFeedbackInput(feedback: FeedbackValue): FeedbackInput {
  switch (feedback.kind) {
    case "bug":
      return {
        kind: "bug",
        title: feedback.title,
        problem: feedback.problem,
        reproduction: feedback.reproduction,
        expectedBehavior: feedback.expected_behavior,
        ...(feedback.relevant_output === undefined ? {} : { relevantOutput: feedback.relevant_output }),
      }
    case "feature":
      return {
        kind: "feature",
        title: feedback.title,
        problem: feedback.problem,
        desiredOutcome: feedback.desired_outcome,
        ...(feedback.constraints === undefined ? {} : { constraints: feedback.constraints }),
      }
    case "other":
      return { kind: "other", title: feedback.title, details: feedback.details }
    default:
      return casesHandled(feedback)
  }
}

function previewFeedback(title: string, body: string, label: string | undefined, previewID: string): string {
  return [
    "Feedback preview (not submitted)",
    "",
    `Title: ${title}`,
    `Label: ${label ?? "none"}`,
    "",
    "Body:",
    body,
    "",
    `Preview ID: ${previewID}`,
  ].join("\n")
}

function failureMessage(error: { tag: FeedbackToolErrorCode; message?: string }): string {
  return error.message ?? "Feedback submission was cancelled"
}

export function createFeedbackTool(dependencies: FeedbackToolDependencies): FeedbackTool {
  type Preview = Readonly<{
    sessionID: string
    draft: FeedbackDraft
    expiresAt: number
    timer: ReturnType<typeof setTimeout>
  }>
  const previews = new Map<string, Preview>()
  const pendingPreviews = new Map<string, Set<symbol>>()
  const now = dependencies.now ?? Date.now
  const clearPreview = (id: string) => {
    const preview = previews.get(id)
    if (preview === undefined) return
    clearTimeout(preview.timer)
    previews.delete(id)
  }
  const clearExpired = () => {
    const current = now()
    for (const [id, preview] of previews) {
      if (preview.expiresAt <= current) clearPreview(id)
    }
  }
  const definition = tool({
    description: [
      "Preview or deliver PR tracker feedback. Always call preview first, then present its exact output with the OpenCode question tool using Browser, GitHub CLI, and Cancel choices. Call deliver with that preview ID only after the user approves Browser or GitHub CLI; return the resulting URL in chat.",
      "Bug guidance: https://github.com/hcrosse/opencode-pr-tracker/blob/main/.github/ISSUE_TEMPLATE/bug_report.md",
      "Feature guidance: https://github.com/hcrosse/opencode-pr-tracker/blob/main/.github/ISSUE_TEMPLATE/feature_request.md",
      "Diagnostics are optional. Never include session messages, attachments, local paths, repository names, or pull request URLs unless the user explicitly supplied and approved them as feedback content.",
    ].join("\n"),
    args: { request: requestSchema },
    async execute({ request }, context) {
      clearExpired()
      if (request.action === "preview") {
        const pending = pendingPreviews.get(context.sessionID) ?? new Set<symbol>()
        pendingPreviews.set(context.sessionID, pending)
        const pendingID = Symbol()
        pending.add(pendingID)
        let sessionActive = false
        const diagnostics = await Promise.resolve(
          request.include_diagnostics ? dependencies.readDiagnostics(context.abort) : undefined,
        ).finally(() => {
          sessionActive = pending.has(pendingID)
          pending.delete(pendingID)
          if (pending.size === 0 && pendingPreviews.get(context.sessionID) === pending) {
            pendingPreviews.delete(context.sessionID)
          }
        })
        if (!sessionActive) {
          throw new FeedbackToolError("FeedbackPreviewNotFound", "Preview feedback again before delivery")
        }
        const draft = createFeedbackDraft(toFeedbackInput(request.feedback), diagnostics)
        if (!draft.ok) throw new FeedbackToolError(draft.error.tag, draft.error.message)
        const previewID = (dependencies.createPreviewID ?? randomUUID)()
        clearPreview(previewID)
        const expiresAt = now() + 15 * 60 * 1_000
        const timer = setTimeout(() => clearPreview(previewID), Math.max(0, expiresAt - now()))
        timer.unref()
        previews.set(previewID, {
          sessionID: context.sessionID,
          draft: draft.value,
          expiresAt,
          timer,
        })
        return previewFeedback(draft.value.title, draft.value.body, draft.value.label, previewID)
      }

      const preview = previews.get(request.preview_id)
      if (preview === undefined || preview.sessionID !== context.sessionID) {
        throw new FeedbackToolError("FeedbackPreviewNotFound", "Preview feedback again before delivery")
      }
      clearPreview(request.preview_id)
      const draft = preview.draft

      if (request.delivery === "browser") {
        const url = createFeedbackIssueUrl(draft)
        const result = await openFeedbackDraft(draft, {
          ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
          ...(dependencies.runner === undefined ? {} : { runner: dependencies.runner }),
          signal: context.abort,
        })
        if (!result.ok) {
          throw new FeedbackToolError(
            result.error.tag,
            `${failureMessage(result.error)}. Preview and approve again before retry.`,
          )
        }
        return url
      }

      const result = await submitFeedbackDraft(draft, {
        ...(dependencies.runner === undefined ? {} : { runner: dependencies.runner }),
        signal: context.abort,
      })
      if (!result.ok) {
        throw new FeedbackToolError(
          result.error.tag,
          `${failureMessage(result.error)}. Preview and approve again before retry.`,
        )
      }
      return result.value
    },
  })
  return Object.assign(definition, {
    clearSession(sessionID: string) {
      pendingPreviews.get(sessionID)?.clear()
      pendingPreviews.delete(sessionID)
      for (const [id, preview] of previews) {
        if (preview.sessionID === sessionID) clearPreview(id)
      }
    },
  })
}
