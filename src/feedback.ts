import { casesHandled } from "./exhaustive.js"
import type { Result } from "./url.js"

export type FeedbackKind = "bug" | "feature" | "other"

export type FeedbackDiagnostics = Readonly<{
  pluginVersion: string
  opencodeVersion: string
  operatingSystem: string
  installationSource: string
}>

export type FeedbackInput =
  | Readonly<{
      kind: "bug"
      title: string
      problem: string
      reproduction: string
      expectedBehavior: string
    }>
  | Readonly<{
      kind: "feature"
      title: string
      problem: string
      desiredOutcome: string
      constraints?: string
    }>
  | Readonly<{ kind: "other"; title: string; details: string }>

export type FeedbackDraft = Readonly<{
  title: string
  body: string
  label?: "bug" | "enhancement"
  template?: "bug_report.md" | "feature_request.md"
}>

export type FeedbackFailure = Readonly<{
  tag: "InvalidFeedback"
  message: string
}>

function trimRequired(value: string, field: string): Result<string, FeedbackFailure> {
  const trimmed = value.trim()
  if (trimmed !== "") return { ok: true, value: trimmed }

  return {
    ok: false,
    error: { tag: "InvalidFeedback", message: `${field} must not be empty` },
  }
}

function appendDiagnostics(
  draft: FeedbackDraft,
  diagnostics: FeedbackDiagnostics | undefined,
): Result<FeedbackDraft, FeedbackFailure> {
  if (diagnostics === undefined) return { ok: true, value: draft }

  const entries = [
    ["pluginVersion", "Plugin version", diagnostics.pluginVersion],
    ["opencodeVersion", "OpenCode version", diagnostics.opencodeVersion],
    ["operatingSystem", "Operating system", diagnostics.operatingSystem],
    ["installationSource", "Installation source", diagnostics.installationSource],
  ] as const
  const lines: string[] = []

  for (const [field, label, value] of entries) {
    const trimmed = trimRequired(value, field)
    if (!trimmed.ok) return trimmed
    lines.push(`- ${label}: ${trimmed.value}`)
  }

  return {
    ok: true,
    value: {
      ...draft,
      body: [draft.body, "", "## Diagnostics", "", ...lines].join("\n"),
    },
  }
}

export function createFeedbackDraft(
  input: FeedbackInput,
  diagnostics?: FeedbackDiagnostics,
): Result<FeedbackDraft, FeedbackFailure> {
  const title = trimRequired(input.title, "title")
  if (!title.ok) return title

  switch (input.kind) {
    case "bug": {
      const problem = trimRequired(input.problem, "problem")
      if (!problem.ok) return problem
      const reproduction = trimRequired(input.reproduction, "reproduction")
      if (!reproduction.ok) return reproduction
      const expectedBehavior = trimRequired(input.expectedBehavior, "expectedBehavior")
      if (!expectedBehavior.ok) return expectedBehavior

      return appendDiagnostics(
        {
          title: title.value,
          body: [
            "## Problem",
            "",
            problem.value,
            "",
            "## Reproduction",
            "",
            reproduction.value,
            "",
            "## Expected Behavior",
            "",
            expectedBehavior.value,
          ].join("\n"),
          label: "bug",
          template: "bug_report.md",
        },
        diagnostics,
      )
    }
    case "feature": {
      const problem = trimRequired(input.problem, "problem")
      if (!problem.ok) return problem
      const desiredOutcome = trimRequired(input.desiredOutcome, "desiredOutcome")
      if (!desiredOutcome.ok) return desiredOutcome
      const body = ["## Problem", "", problem.value, "", "## Desired Outcome", "", desiredOutcome.value]
      const constraints = input.constraints?.trim()
      if (constraints !== undefined && constraints !== "") {
        body.push("", "## Constraints", "", constraints)
      }

      return appendDiagnostics(
        {
          title: title.value,
          body: body.join("\n"),
          label: "enhancement",
          template: "feature_request.md",
        },
        diagnostics,
      )
    }
    case "other": {
      const details = trimRequired(input.details, "details")
      if (!details.ok) return details

      return appendDiagnostics(
        {
          title: title.value,
          body: ["## Details", "", details.value].join("\n"),
        },
        diagnostics,
      )
    }
    default:
      return casesHandled(input)
  }
}

export function createFeedbackIssueUrl(draft: FeedbackDraft): string {
  const url = new URL("https://github.com/hcrosse/opencode-pr-tracker/issues/new")
  url.searchParams.set("title", draft.title)
  url.searchParams.set("body", draft.body)
  if (draft.label !== undefined) url.searchParams.set("labels", draft.label)
  if (draft.template !== undefined) url.searchParams.set("template", draft.template)
  return url.toString()
}
