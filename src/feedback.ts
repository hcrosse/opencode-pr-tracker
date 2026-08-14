import { casesHandled } from "./exhaustive.js"
import { openExternalUrl } from "./external-url.js"
import { execFileRunner, type ProcessRunner } from "./github.js"
import type { Result } from "./url.js"

export type FeedbackKind = "bug" | "feature" | "other"

export type FeedbackDiagnostics = Readonly<{
  pluginVersion: string
  opencodeVersion: string
  operatingSystem: string
}>

export type FeedbackInput =
  | Readonly<{
      kind: "bug"
      title: string
      problem: string
      reproduction: string
      expectedBehavior: string
      relevantOutput?: string
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

export type OpenFeedbackFailure =
  | Readonly<{ tag: "UnsupportedPlatform"; message: string; platform: string }>
  | Readonly<{ tag: "OpenFeedbackCancelled" }>
  | Readonly<{
      tag: "FeedbackUrlTooLong"
      message: "Feedback is too long for browser delivery; choose GitHub CLI delivery"
    }>
  | Readonly<{
      tag: "OpenFeedbackFailed"
      message: "Unable to open feedback; choose GitHub CLI delivery or retry"
      cause: unknown
    }>

export type SubmitFeedbackFailure =
  | Readonly<{
      tag: "GitHubCliMissing"
      message: "GitHub CLI is not installed; install gh and retry"
      cause: unknown
    }>
  | Readonly<{
      tag: "GitHubAuthenticationRequired"
      message: "GitHub CLI authentication required; run gh auth login"
      cause: unknown
    }>
  | Readonly<{ tag: "SubmitFeedbackCancelled" }>
  | Readonly<{
      tag: "InvalidGitHubResponse"
      message: "GitHub CLI did not return the created issue URL"
    }>
  | Readonly<{
      tag: "SubmitFeedbackFailed"
      message: "Unable to submit feedback with GitHub CLI; choose browser delivery or retry"
      cause: unknown
    }>

type ProcessExecutionFailed = Readonly<{
  tag: "ProcessExecutionFailed"
  code: string | number | null
  stderr: string
  stdout: string
  cause: unknown
}>

function parseProcessExecutionFailed(value: unknown): ProcessExecutionFailed | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("tag" in value) ||
    value.tag !== "ProcessExecutionFailed" ||
    !("code" in value) ||
    (value.code !== null && typeof value.code !== "string" && typeof value.code !== "number") ||
    !("stderr" in value) ||
    typeof value.stderr !== "string" ||
    !("stdout" in value) ||
    typeof value.stdout !== "string" ||
    !("cause" in value)
  ) {
    return undefined
  }

  return {
    tag: "ProcessExecutionFailed",
    code: value.code,
    stderr: value.stderr,
    stdout: value.stdout,
    cause: value.cause,
  }
}

function isProcessCancellation(cause: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true
  const originalCause = parseProcessExecutionFailed(cause)?.cause ?? cause
  return originalCause instanceof Error && originalCause.name === "AbortError"
}

const authenticationFailureMarkers = ["http 401", "bad credentials", "not logged into", "gh auth login"] as const

function isAuthenticationFailure(failure: ProcessExecutionFailed): boolean {
  if (failure.code === 4) return true
  const stderr = failure.stderr.toLowerCase()
  return authenticationFailureMarkers.some((marker) => stderr.includes(marker))
}

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
  format: "diagnostics" | "environment" = "diagnostics",
): Result<FeedbackDraft, FeedbackFailure> {
  if (diagnostics === undefined) {
    if (format === "diagnostics") return { ok: true, value: draft }
    return {
      ok: true,
      value: {
        ...draft,
        body: [
          draft.body,
          "",
          "## Environment",
          "",
          "- OpenCode version: not provided",
          "- Plugin version or commit: not provided",
          "- Operating system: not provided",
        ].join("\n"),
      },
    }
  }

  const entries =
    format === "environment"
      ? ([
          ["opencodeVersion", "OpenCode version", diagnostics.opencodeVersion],
          ["pluginVersion", "Plugin version or commit", diagnostics.pluginVersion],
          ["operatingSystem", "Operating system", diagnostics.operatingSystem],
        ] as const)
      : ([
          ["pluginVersion", "Plugin version", diagnostics.pluginVersion],
          ["opencodeVersion", "OpenCode version", diagnostics.opencodeVersion],
          ["operatingSystem", "Operating system", diagnostics.operatingSystem],
        ] as const)
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
      body: [draft.body, "", format === "environment" ? "## Environment" : "## Diagnostics", "", ...lines].join("\n"),
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

      const withDiagnostics = appendDiagnostics(
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
        "environment",
      )
      if (!withDiagnostics.ok) return withDiagnostics
      const relevantOutput = input.relevantOutput?.trim()
      if (relevantOutput === undefined || relevantOutput === "") return withDiagnostics
      return {
        ok: true,
        value: {
          ...withDiagnostics.value,
          body: [withDiagnostics.value.body, "", "## Relevant Output", "", relevantOutput].join("\n"),
        },
      }
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
  if (draft.template !== undefined) url.searchParams.set("template", draft.template)
  return url.toString()
}

export async function openFeedbackDraft(
  draft: FeedbackDraft,
  options: Readonly<{ platform?: string; runner?: ProcessRunner; signal?: AbortSignal }> = {},
): Promise<Result<void, OpenFeedbackFailure>> {
  const url = createFeedbackIssueUrl(draft)
  if (url.length > 8_000) {
    return {
      ok: false,
      error: {
        tag: "FeedbackUrlTooLong",
        message: "Feedback is too long for browser delivery; choose GitHub CLI delivery",
      },
    }
  }
  const result = await openExternalUrl(url, "feedback", options)
  if (result.ok) return result
  if (result.error.tag === "UnsupportedPlatform") {
    return {
      ok: false,
      error: result.error,
    }
  }
  if (isProcessCancellation(result.error.cause, options.signal)) {
    return { ok: false, error: { tag: "OpenFeedbackCancelled" } }
  }
  return {
    ok: false,
    error: {
      tag: "OpenFeedbackFailed",
      message: "Unable to open feedback; choose GitHub CLI delivery or retry",
      cause: result.error.cause,
    },
  }
}

export async function submitFeedbackDraft(
  draft: FeedbackDraft,
  options: Readonly<{ runner?: ProcessRunner; signal?: AbortSignal }> = {},
): Promise<Result<string, SubmitFeedbackFailure>> {
  const args = [
    "issue",
    "create",
    "--repo",
    "hcrosse/opencode-pr-tracker",
    "--title",
    draft.title,
    "--body",
    draft.body,
  ]
  if (draft.label !== undefined) args.push("--label", draft.label)

  let stdout: string
  try {
    const result = await (options.runner ?? execFileRunner)(
      "gh",
      args,
      options.signal ? { signal: options.signal } : {},
    )
    stdout = result.stdout
  } catch (cause) {
    if (isProcessCancellation(cause, options.signal)) {
      return { ok: false, error: { tag: "SubmitFeedbackCancelled" } }
    }
    const failure = parseProcessExecutionFailed(cause)
    if (failure?.code === "ENOENT") {
      return {
        ok: false,
        error: {
          tag: "GitHubCliMissing",
          message: "GitHub CLI is not installed; install gh and retry",
          cause,
        },
      }
    }
    if (failure !== undefined && isAuthenticationFailure(failure)) {
      return {
        ok: false,
        error: {
          tag: "GitHubAuthenticationRequired",
          message: "GitHub CLI authentication required; run gh auth login",
          cause,
        },
      }
    }
    return {
      ok: false,
      error: {
        tag: "SubmitFeedbackFailed",
        message: "Unable to submit feedback with GitHub CLI; choose browser delivery or retry",
        cause,
      },
    }
  }

  const issueUrl = parseCreatedIssueUrl(stdout)
  if (issueUrl === undefined) {
    return {
      ok: false,
      error: {
        tag: "InvalidGitHubResponse",
        message: "GitHub CLI did not return the created issue URL",
      },
    }
  }
  return { ok: true, value: issueUrl }
}

function parseCreatedIssueUrl(stdout: string): string | undefined {
  const value = stdout.trim()
  if (/\s/.test(value)) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.hostname !== "github.com") return undefined
    if (url.port !== "") return undefined
    if (!/^\/hcrosse\/opencode-pr-tracker\/issues\/[1-9]\d*$/.test(url.pathname)) return undefined
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined
    return url.toString()
  } catch {
    return undefined
  }
}
