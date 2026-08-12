/** @jsxImportSource @opentui/solid */
import { useKeyboard, type JSX } from "@opentui/solid"
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui"
import { createSignal } from "solid-js"

import { casesHandled } from "./exhaustive.js"
import {
  createFeedbackDraft,
  openFeedbackDraft,
  submitFeedbackDraft,
  type FeedbackDiagnostics,
  type FeedbackDraft,
  type FeedbackInput,
  type FeedbackKind,
} from "./feedback.js"
import type { ProcessRunner } from "./github.js"

export type FeedbackTuiDependencies = Readonly<{
  runner?: ProcessRunner
  platform?: string
  confirmationRenderer?: FeedbackConfirmationRenderer
}>

export type FeedbackReleaseContext = Pick<TuiPluginMeta, "source" | "version">

export type FeedbackCommand = Readonly<{
  name: "pr.tracker.feedback"
  title: "Send PR tracker feedback"
  category: "Plugin"
  namespace: "palette"
  slashName: "pr-tracker-feedback"
  run(): Promise<void>
}>

type Delivery = "browser" | "gh"

export type FeedbackConfirmationProps = Readonly<{
  preview: string
  onConfirm(): void
  onCancel(): void
}>

export type FeedbackConfirmationRenderer = (props: FeedbackConfirmationProps) => JSX.Element

export function FeedbackConfirmation(props: FeedbackConfirmationProps): JSX.Element {
  useKeyboard((key) => {
    if (key.name === "return") {
      key.preventDefault()
      key.stopPropagation()
      props.onConfirm()
      return
    }
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      key.preventDefault()
      key.stopPropagation()
      props.onCancel()
    }
  })

  return (
    <box flexDirection="column" gap={1}>
      <text>
        <b>Send PR tracker feedback?</b>
      </text>
      <scrollbox focused scrollY height={10}>
        <text>{props.preview}</text>
      </scrollbox>
      <box flexDirection="row" gap={2}>
        <text onMouseUp={props.onCancel}>[Esc] Cancel</text>
        <text onMouseUp={props.onConfirm}>[Enter] Send</text>
      </box>
    </box>
  )
}

function showDialog<Value>(
  api: TuiPluginApi,
  signal: AbortSignal,
  render: (finish: (value: Value | undefined) => void) => JSX.Element,
): Promise<Value | undefined> {
  return new Promise((resolve) => {
    let finished = false
    const onAbort = () => finish(undefined)
    const finish = (value: Value | undefined, clearDialog = true) => {
      if (finished) return
      finished = true
      signal.removeEventListener("abort", onAbort)
      if (clearDialog) api.ui.dialog.clear()
      resolve(value)
    }

    if (signal.aborted) {
      finish(undefined, false)
      return
    }
    signal.addEventListener("abort", onAbort, { once: true })

    api.ui.dialog.setSize("medium")
    api.ui.dialog.replace(
      () => render((value) => finish(value)),
      () => finish(undefined, false),
    )
  })
}

function selectFeedbackKind(api: TuiPluginApi, signal: AbortSignal): Promise<FeedbackKind | undefined> {
  return showDialog(api, signal, (finish) => {
    const DialogSelect = api.ui.DialogSelect<FeedbackKind>
    return (
      <DialogSelect
        title="Feedback type"
        options={[
          { title: "Bug report", value: "bug" },
          { title: "Feature request", value: "feature" },
          { title: "Other feedback", value: "other" },
        ]}
        current="bug"
        onSelect={(option) => finish(option.value)}
      />
    )
  })
}

function promptForValue(
  api: TuiPluginApi,
  signal: AbortSignal,
  title: string,
  required: boolean,
): Promise<string | undefined> {
  return showDialog(api, signal, (finish) => {
    const [error, setError] = createSignal<string>()
    const DialogPrompt = api.ui.DialogPrompt
    return (
      <DialogPrompt
        title={title}
        description={() => (error() ? <text fg={api.theme.current.error}>{error()}</text> : null)}
        onConfirm={(value) => {
          if (required && value.trim() === "") {
            setError(`${title} is required`)
            return
          }
          finish(value)
        }}
        onCancel={() => finish(undefined)}
      />
    )
  })
}

function confirmDiagnostics(
  api: TuiPluginApi,
  signal: AbortSignal,
  diagnostics: FeedbackDiagnostics,
): Promise<boolean | undefined> {
  const message = [
    `Plugin version: ${diagnostics.pluginVersion}`,
    `OpenCode version: ${diagnostics.opencodeVersion}`,
    `Operating system: ${diagnostics.operatingSystem}`,
    `Installation source: ${diagnostics.installationSource}`,
  ].join("\n")
  return showDialog(api, signal, (finish) => (
    <api.ui.DialogConfirm
      title="Include diagnostics?"
      message={message}
      onConfirm={() => finish(true)}
      onCancel={() => finish(false)}
    />
  ))
}

function selectDelivery(api: TuiPluginApi, signal: AbortSignal): Promise<Delivery | undefined> {
  return showDialog(api, signal, (finish) => {
    const DialogSelect = api.ui.DialogSelect<Delivery>
    return (
      <DialogSelect
        title="Send feedback"
        options={[
          { title: "Open in browser", value: "browser" },
          { title: "Submit with GitHub CLI", value: "gh" },
        ]}
        current="browser"
        onSelect={(option) => finish(option.value)}
      />
    )
  })
}

function deliveryAction(delivery: Delivery): string {
  return delivery === "browser" ? "Open a prefilled issue in your browser" : "Create the issue with GitHub CLI"
}

function feedbackPreview(draft: FeedbackDraft, delivery: Delivery): string {
  const label =
    delivery === "gh"
      ? "none"
      : draft.template === "bug_report.md"
        ? "bug"
        : draft.template === "feature_request.md"
          ? "enhancement"
          : "none"
  return [
    "Repository: hcrosse/opencode-pr-tracker",
    `Action: ${deliveryAction(delivery)}`,
    `Title: ${draft.title}`,
    `Label: ${label}`,
    "",
    "Body:",
    draft.body,
  ].join("\n")
}

function confirmFeedback(
  api: TuiPluginApi,
  signal: AbortSignal,
  draft: FeedbackDraft,
  delivery: Delivery,
  confirmationRenderer: FeedbackConfirmationRenderer,
) {
  return showDialog(api, signal, (finish) => {
    const Confirmation = confirmationRenderer
    return (
      <Confirmation
        preview={feedbackPreview(draft, delivery)}
        onConfirm={() => finish(true)}
        onCancel={() => finish(false)}
      />
    )
  })
}

async function collectFeedbackInput(
  api: TuiPluginApi,
  signal: AbortSignal,
  kind: FeedbackKind,
): Promise<FeedbackInput | undefined> {
  const title = await promptForValue(api, signal, "Feedback title", true)
  if (title === undefined) return undefined

  switch (kind) {
    case "bug": {
      const problem = await promptForValue(api, signal, "Problem", true)
      if (problem === undefined) return undefined
      const reproduction = await promptForValue(api, signal, "Reproduction steps", true)
      if (reproduction === undefined) return undefined
      const expectedBehavior = await promptForValue(api, signal, "Expected behavior", true)
      if (expectedBehavior === undefined) return undefined
      return { kind, title, problem, reproduction, expectedBehavior }
    }
    case "feature": {
      const problem = await promptForValue(api, signal, "Problem", true)
      if (problem === undefined) return undefined
      const desiredOutcome = await promptForValue(api, signal, "Desired outcome", true)
      if (desiredOutcome === undefined) return undefined
      const constraints = await promptForValue(api, signal, "Constraints (optional)", false)
      if (constraints === undefined) return undefined
      return { kind, title, problem, desiredOutcome, constraints }
    }
    case "other": {
      const details = await promptForValue(api, signal, "Details", true)
      if (details === undefined) return undefined
      return { kind, title, details }
    }
    default:
      return casesHandled(kind)
  }
}

export function createFeedbackCommand(
  api: TuiPluginApi,
  dependencies: FeedbackTuiDependencies,
  release?: FeedbackReleaseContext,
): FeedbackCommand {
  return {
    name: "pr.tracker.feedback",
    title: "Send PR tracker feedback",
    category: "Plugin",
    namespace: "palette",
    slashName: "pr-tracker-feedback",
    async run() {
      const signal = api.lifecycle.signal
      const kind = await selectFeedbackKind(api, signal)
      if (kind === undefined) return
      const input = await collectFeedbackInput(api, signal, kind)
      if (input === undefined) return

      const diagnostics: FeedbackDiagnostics = {
        pluginVersion: release?.version ?? "unavailable",
        opencodeVersion: api.app.version,
        operatingSystem: `${process.platform}/${process.arch}`,
        installationSource: release?.source ?? "unavailable",
      }
      const includeDiagnostics = await confirmDiagnostics(api, signal, diagnostics)
      if (includeDiagnostics === undefined) return
      const draft = createFeedbackDraft(input, includeDiagnostics ? diagnostics : undefined)
      if (!draft.ok) {
        api.ui.toast({ variant: "error", title: "Pull request tracker", message: draft.error.message })
        return
      }

      const delivery = await selectDelivery(api, signal)
      if (delivery === undefined) return
      const confirmed = await confirmFeedback(
        api,
        signal,
        draft.value,
        delivery,
        dependencies.confirmationRenderer ?? FeedbackConfirmation,
      )
      if (!confirmed || signal.aborted) return

      if (delivery === "browser") {
        const result = await openFeedbackDraft(draft.value, {
          ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
          ...(dependencies.runner === undefined ? {} : { runner: dependencies.runner }),
          signal,
        })
        if (!result.ok && !signal.aborted) {
          api.ui.toast({ variant: "error", title: "Pull request tracker", message: result.error.message })
        }
        return
      }

      const result = await submitFeedbackDraft(draft.value, {
        ...(dependencies.runner === undefined ? {} : { runner: dependencies.runner }),
        signal,
      })
      if (result.ok) {
        if (!signal.aborted) {
          api.ui.toast({ variant: "success", title: "Pull request tracker", message: result.value })
        }
      } else if (result.error.tag !== "SubmitFeedbackCancelled" && !signal.aborted) {
        api.ui.toast({ variant: "error", title: "Pull request tracker", message: result.error.message })
      }
    },
  }
}
