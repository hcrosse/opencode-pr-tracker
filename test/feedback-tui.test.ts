import { describe, expect, test } from "bun:test"

import type {
  TuiDialogConfirmProps,
  TuiDialogPromptProps,
  TuiDialogSelectProps,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui"
import { testRender, type JSX } from "@opentui/solid"

import { createFeedbackCommand, FeedbackConfirmation, type FeedbackConfirmationProps } from "../src/feedback-tui.jsx"
import type { ProcessRunner } from "../src/github.js"

type DialogView =
  | Readonly<{ kind: "select"; props: TuiDialogSelectProps }>
  | Readonly<{ kind: "prompt"; props: TuiDialogPromptProps }>
  | Readonly<{ kind: "confirm"; props: TuiDialogConfirmProps }>
  | Readonly<{ kind: "feedback-confirmation"; props: FeedbackConfirmationProps }>

type ProcessCall = Readonly<{
  file: string
  args: readonly string[]
  options: Readonly<{ signal?: AbortSignal; cwd?: string }>
}>

function createHarness(
  options: Readonly<{
    platform?: string
    runner?: ProcessRunner
    release?: Readonly<{ source: "file" | "npm" | "internal"; version?: string }>
    strictApi?: boolean
  }> = {},
) {
  const controller = new AbortController()
  const dialogs: DialogView[] = []
  const processCalls: ProcessCall[] = []
  const toasts: Array<{ variant?: string; title?: string; message: string }> = []
  const waiters: Array<(dialog: DialogView) => void> = []
  let cursor = 0
  let clearCalls = 0
  let dismissCurrent: (() => void) | undefined

  const present = (dialog: DialogView) => {
    dialogs.push(dialog)
    waiters.shift()?.(dialog)
  }
  const runner: ProcessRunner = async (file, args, runnerOptions) => {
    processCalls.push({ file, args, options: runnerOptions })
    return options.runner?.(file, args, runnerOptions) ?? { stdout: "" }
  }
  const confirmationRenderer = (props: FeedbackConfirmationProps): JSX.Element => {
    present({ kind: "feedback-confirmation", props })
    return null
  }
  const baseApi = {
    app: { version: "1.18.15" },
    lifecycle: { signal: controller.signal },
    ui: {
      DialogSelect(props: TuiDialogSelectProps) {
        present({ kind: "select", props })
        return null
      },
      DialogPrompt(props: TuiDialogPromptProps) {
        present({ kind: "prompt", props })
        return null
      },
      DialogConfirm(props: TuiDialogConfirmProps) {
        present({ kind: "confirm", props })
        return null
      },
      dialog: {
        clear() {
          clearCalls += 1
        },
        setSize() {},
        replace(render: () => unknown, onDismiss?: () => void) {
          dismissCurrent = onDismiss
          render()
        },
      },
      toast(input: { variant?: string; message: string }) {
        toasts.push(input)
      },
    },
  }
  const allowedApiProperties = new Set(["app", "ui", "lifecycle", "keymap", "event", "slots"])
  const api = new Proxy(baseApi, {
    get(target, property, receiver) {
      if (options.strictApi && typeof property === "string" && !allowedApiProperties.has(property)) {
        throw new Error(`Feedback command accessed forbidden TUI state: ${property}`)
      }
      return Reflect.get(target, property, receiver)
    },
  }) as unknown as TuiPluginApi

  return {
    api,
    command: createFeedbackCommand(
      api,
      {
        runner,
        confirmationRenderer,
        ...(options.platform === undefined ? {} : { platform: options.platform }),
      },
      options.release,
    ),
    controller,
    dialogs,
    processCalls,
    toasts,
    clearCalls: () => clearCalls,
    dismiss() {
      dismissCurrent?.()
    },
    next(): Promise<DialogView> {
      const dialog = dialogs[cursor]
      cursor += 1
      if (dialog !== undefined) return Promise.resolve(dialog)
      return new Promise((resolve) => waiters.push(resolve))
    },
  }
}

async function select(harness: ReturnType<typeof createHarness>, value: unknown): Promise<TuiDialogSelectProps> {
  const dialog = await harness.next()
  expect(dialog.kind).toBe("select")
  if (dialog.kind !== "select") throw new Error("expected select dialog")
  const option = dialog.props.options.find((candidate) => candidate.value === value)
  if (option === undefined) throw new Error(`missing select option: ${String(value)}`)
  dialog.props.onSelect?.(option)
  return dialog.props
}

async function prompt(harness: ReturnType<typeof createHarness>, value: string): Promise<TuiDialogPromptProps> {
  const dialog = await harness.next()
  expect(dialog.kind).toBe("prompt")
  if (dialog.kind !== "prompt") throw new Error("expected prompt dialog")
  dialog.props.onConfirm?.(value)
  return dialog.props
}

async function confirm(harness: ReturnType<typeof createHarness>, accepted: boolean): Promise<TuiDialogConfirmProps> {
  const dialog = await harness.next()
  expect(dialog.kind).toBe("confirm")
  if (dialog.kind !== "confirm") throw new Error("expected confirmation dialog")
  if (accepted) dialog.props.onConfirm?.()
  else dialog.props.onCancel?.()
  return dialog.props
}

async function confirmFeedback(
  harness: ReturnType<typeof createHarness>,
  accepted: boolean,
): Promise<FeedbackConfirmationProps> {
  const dialog = await harness.next()
  expect(dialog.kind).toBe("feedback-confirmation")
  if (dialog.kind !== "feedback-confirmation") throw new Error("expected feedback confirmation")
  if (accepted) dialog.props.onConfirm()
  else dialog.props.onCancel()
  return dialog.props
}

async function fillOtherFeedback(harness: ReturnType<typeof createHarness>, includeDiagnostics = false): Promise<void> {
  await select(harness, "other")
  await prompt(harness, "Documentation feedback")
  await prompt(harness, "The installation guide is clear.")
  await confirm(harness, includeDiagnostics)
}

async function fillBugFeedback(harness: ReturnType<typeof createHarness>, includeDiagnostics = true): Promise<void> {
  await select(harness, "bug")
  await prompt(harness, "Sidebar status is stale")
  await prompt(harness, "The sidebar does not update.")
  await prompt(harness, "Attach a pull request, then open the sidebar.")
  await prompt(harness, "The current status appears.")
  await confirm(harness, includeDiagnostics)
}

async function fillFeatureFeedback(harness: ReturnType<typeof createHarness>): Promise<void> {
  await select(harness, "feature")
  await prompt(harness, "Filter attached pull requests")
  await prompt(harness, "Large sessions are difficult to scan.")
  await prompt(harness, "Users can filter by repository.")
  await prompt(harness, "")
  await confirm(harness, false)
}

function processExecutionFailed(code: string | number | null, stderr: string): Readonly<Record<string, unknown>> {
  return {
    tag: "ProcessExecutionFailed",
    code,
    stderr,
    stdout: "",
    cause: new Error("process failed"),
  }
}

describe("createFeedbackCommand", () => {
  test("defaults to browser delivery and opens only after final confirmation", async () => {
    const harness = createHarness({ platform: "darwin" })
    const run = harness.command.run()
    await fillOtherFeedback(harness)

    const delivery = await select(harness, "browser")
    expect(delivery.options.map(({ value }) => value)).toEqual(["browser", "gh"])
    expect(delivery.current).toBe("browser")

    const final = await harness.next()
    expect(final.kind).toBe("feedback-confirmation")
    expect(harness.processCalls).toEqual([])
    if (final.kind !== "feedback-confirmation") throw new Error("expected final confirmation")
    expect(final.props.title).toBe("Open PR tracker feedback?")
    expect(final.props.confirmLabel).toBe("[Enter] Open issue")
    final.props.onConfirm()
    await run

    expect(harness.processCalls).toHaveLength(1)
    expect(harness.processCalls[0]?.file).toBe("open")
    const issueUrl = new URL(harness.processCalls[0]?.args[0] ?? "")
    expect(issueUrl.searchParams.get("title")).toBe("Documentation feedback")
    expect(issueUrl.searchParams.get("body")).toBe("## Details\n\nThe installation guide is clear.")
  })

  test("allows keyboard selection of direct GitHub CLI submission", async () => {
    const issueUrl = "https://github.com/hcrosse/opencode-pr-tracker/issues/69"
    const harness = createHarness({
      runner: async () => ({ stdout: `${issueUrl}\n` }),
    })
    const run = harness.command.run()
    await fillBugFeedback(harness, false)
    await select(harness, "gh")
    const final = await confirmFeedback(harness, true)
    await run

    expect(final.title).toBe("Send PR tracker feedback?")
    expect(final.confirmLabel).toBe("[Enter] Send")
    expect(final.preview).toContain("Label: none")
    expect(harness.processCalls[0]).toMatchObject({
      file: "gh",
      args: [
        "issue",
        "create",
        "--repo",
        "hcrosse/opencode-pr-tracker",
        "--title",
        "Sidebar status is stale",
        "--body",
        [
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
        ].join("\n"),
      ],
    })
    expect(harness.processCalls[0]?.args).not.toContain("--label")
    expect(harness.toasts).toEqual([{ variant: "success", title: "Pull request tracker", message: issueUrl }])
  })

  test.each([
    {
      kind: "bug",
      values: ["Title", "Problem", "Steps", "Expected"],
      titles: ["Feedback title", "Problem", "Reproduction steps", "Expected behavior"],
    },
    {
      kind: "feature",
      values: ["Title", "Problem", "Outcome", ""],
      titles: ["Feedback title", "Problem", "Desired outcome", "Constraints (optional)"],
    },
    {
      kind: "other",
      values: ["Title", "Details"],
      titles: ["Feedback title", "Details"],
    },
  ])("requests only $kind-specific fields", async ({ kind, values, titles }) => {
    const harness = createHarness()
    const run = harness.command.run()
    await select(harness, kind)
    const prompts: TuiDialogPromptProps[] = []
    for (const value of values) prompts.push(await prompt(harness, value))

    expect(prompts.map(({ title }) => title).join("\n")).toBe(titles.join("\n"))
    const diagnostics = await harness.next()
    expect(diagnostics.kind).toBe("confirm")
    harness.dismiss()
    await run
    expect(harness.processCalls).toEqual([])
  })

  test("keeps required prompts open with an inline error when blank", async () => {
    const harness = createHarness()
    const run = harness.command.run()
    await select(harness, "other")
    const title = await harness.next()
    expect(title.kind).toBe("prompt")
    if (title.kind !== "prompt") throw new Error("expected title prompt")

    title.props.onConfirm?.(" \n\t ")
    await Bun.sleep(0)

    expect(harness.dialogs).toHaveLength(2)
    expect(title.props.description).toBeFunction()
    harness.dismiss()
    await run
  })

  test("shows the exact diagnostics preview and omits declined diagnostics", async () => {
    const release = { source: "npm", version: "0.3.0" } as const
    const included = createHarness({ platform: "darwin", release })
    const includedRun = included.command.run()
    await select(included, "other")
    await prompt(included, "Diagnostic context")
    await prompt(included, "The command exits without opening GitHub.")
    const diagnostics = await confirm(included, true)
    expect(diagnostics.message).toBe(
      [
        "Plugin version: 0.3.0",
        "OpenCode version: 1.18.15",
        `Operating system: ${process.platform}/${process.arch}`,
        "Installation source: npm",
      ].join("\n"),
    )
    await select(included, "browser")
    const includedFinal = await included.next()
    expect(includedFinal.kind).toBe("feedback-confirmation")
    if (includedFinal.kind !== "feedback-confirmation") throw new Error("expected final confirmation")
    expect(includedFinal.props.preview).toContain(
      [
        "## Diagnostics",
        "",
        "- Plugin version: 0.3.0",
        "- OpenCode version: 1.18.15",
        `- Operating system: ${process.platform}/${process.arch}`,
        "- Installation source: npm",
      ].join("\n"),
    )
    included.dismiss()
    await includedRun

    const declined = createHarness({ release })
    const declinedRun = declined.command.run()
    await fillOtherFeedback(declined, false)
    await select(declined, "browser")
    const declinedFinal = await declined.next()
    expect(declinedFinal.kind).toBe("feedback-confirmation")
    if (declinedFinal.kind !== "feedback-confirmation") throw new Error("expected final confirmation")
    expect(declinedFinal.props.preview).not.toContain("## Diagnostics")
    declined.dismiss()
    await declinedRun
  })

  test("shows the exact immutable draft and browser action before delivery", async () => {
    const harness = createHarness({ platform: "darwin" })
    const run = harness.command.run()
    await fillBugFeedback(harness, false)
    await select(harness, "browser")
    const final = await harness.next()
    expect(final.kind).toBe("feedback-confirmation")
    if (final.kind !== "feedback-confirmation") throw new Error("expected final confirmation")

    expect(final.props.preview).toBe(
      [
        "Repository: hcrosse/opencode-pr-tracker",
        "Action: Open a prefilled issue in your browser",
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
      ].join("\n"),
    )
    final.props.onConfirm()
    await run
    const issueUrl = new URL(harness.processCalls[0]?.args[0] ?? "")
    expect(issueUrl.searchParams.get("template")).toBe("bug_report.md")
    expect(issueUrl.searchParams.has("labels")).toBe(false)
  })

  test("previews the feature template label for browser delivery", async () => {
    const harness = createHarness()
    const run = harness.command.run()
    await fillFeatureFeedback(harness)
    await select(harness, "browser")
    const final = await harness.next()
    expect(final.kind).toBe("feedback-confirmation")
    if (final.kind !== "feedback-confirmation") throw new Error("expected final confirmation")

    expect(final.props.preview).toContain("Label: enhancement")
    harness.dismiss()
    await run
  })

  test("shows the browser length failure without executing a process", async () => {
    const harness = createHarness({ platform: "darwin" })
    const run = harness.command.run()
    await select(harness, "other")
    await prompt(harness, "Long feedback")
    await prompt(harness, "x".repeat(8_000))
    await confirm(harness, false)
    await select(harness, "browser")
    await confirmFeedback(harness, true)
    await run

    expect(harness.processCalls).toEqual([])
    expect(harness.toasts).toEqual([
      {
        variant: "error",
        title: "Pull request tracker",
        message: "Feedback is too long for browser delivery; choose GitHub CLI delivery",
      },
    ])
  })

  test("dismisses every wizard dialog without running a process", async () => {
    const actions: Array<(harness: ReturnType<typeof createHarness>) => Promise<unknown>> = [
      (harness) => select(harness, "bug"),
      (harness) => prompt(harness, "Title"),
      (harness) => prompt(harness, "Problem"),
      (harness) => prompt(harness, "Steps"),
      (harness) => prompt(harness, "Expected"),
      (harness) => confirm(harness, false),
      (harness) => select(harness, "browser"),
      (harness) => confirmFeedback(harness, true),
    ]

    for (let dismissAt = 0; dismissAt < actions.length; dismissAt += 1) {
      const harness = createHarness({ platform: "darwin" })
      const run = harness.command.run()
      for (const action of actions.slice(0, dismissAt)) await action(harness)
      await harness.next()
      harness.dismiss()
      const outcome = await Promise.race([
        run.then(() => "resolved" as const),
        Bun.sleep(20).then(() => "pending" as const),
      ])

      expect(outcome).toBe("resolved")
      expect(harness.processCalls).toEqual([])
    }
  })

  test("lifecycle abort clears the dialog and makes its callbacks stale", async () => {
    const harness = createHarness({ platform: "darwin" })
    const run = harness.command.run()
    await fillOtherFeedback(harness)
    await select(harness, "browser")
    const final = await harness.next()
    expect(final.kind).toBe("feedback-confirmation")
    if (final.kind !== "feedback-confirmation") throw new Error("expected final confirmation")
    const clearsBeforeAbort = harness.clearCalls()

    harness.controller.abort()
    await run
    final.props.onConfirm()
    await Bun.sleep(0)

    expect(harness.clearCalls()).toBe(clearsBeforeAbort + 1)
    expect(harness.processCalls).toEqual([])
    expect(harness.toasts).toEqual([])
  })

  test.each([
    {
      name: "unsupported browser platform",
      delivery: "browser",
      platform: "win32",
      message: "Opening feedback is unsupported on win32",
    },
    {
      name: "missing GitHub CLI",
      delivery: "gh",
      runner: async () => {
        throw processExecutionFailed("ENOENT", "command not found")
      },
      message: "GitHub CLI is not installed; install gh and retry",
    },
    {
      name: "missing GitHub authentication",
      delivery: "gh",
      runner: async () => {
        throw processExecutionFailed(4, "not logged into any GitHub hosts")
      },
      message: "GitHub CLI authentication required; run gh auth login",
    },
    {
      name: "generic browser failure",
      delivery: "browser",
      platform: "darwin",
      runner: async () => {
        throw new Error("open failed")
      },
      message: "Unable to open feedback; choose GitHub CLI delivery or retry",
    },
    {
      name: "generic GitHub CLI failure",
      delivery: "gh",
      runner: async () => {
        throw processExecutionFailed(1, "network unavailable")
      },
      message: "Unable to submit feedback with GitHub CLI; choose browser delivery or retry",
    },
  ] satisfies readonly {
    name: string
    delivery: "browser" | "gh"
    platform?: string
    runner?: ProcessRunner
    message: string
  }[])("shows an actionable toast for $name", async ({ delivery, platform, runner, message }) => {
    const harness = createHarness({
      ...(platform === undefined ? {} : { platform }),
      ...(runner === undefined ? {} : { runner }),
    })
    const run = harness.command.run()
    await fillOtherFeedback(harness)
    await select(harness, delivery)
    await confirmFeedback(harness, true)
    await run

    expect(harness.toasts).toEqual([{ variant: "error", title: "Pull request tracker", message }])
  })

  test("uses release diagnostics without reading forbidden TUI state", async () => {
    const harness = createHarness({
      strictApi: true,
      release: { source: "npm", version: "0.3.0" },
    })
    expect(() => harness.api.state).toThrow("Feedback command accessed forbidden TUI state: state")
    const run = harness.command.run()
    await fillOtherFeedback(harness, true)
    await select(harness, "browser")
    const final = await harness.next()
    expect(final.kind).toBe("feedback-confirmation")
    if (final.kind !== "feedback-confirmation") throw new Error("expected final confirmation")

    expect(final.props.preview).toContain("- Plugin version: 0.3.0")
    expect(final.props.preview).toContain("- Installation source: npm")
    harness.dismiss()
    await run
  })

  test.each([
    {
      title: "Open PR tracker feedback?",
      confirmLabel: "[Enter] Open issue",
    },
    {
      title: "Send PR tracker feedback?",
      confirmLabel: "[Enter] Send",
    },
  ])("renders a bounded scrollable preview with persistent $confirmLabel controls", async ({ title, confirmLabel }) => {
    const preview = [
      "Repository: hcrosse/opencode-pr-tracker",
      "Action: Open a prefilled issue in your browser",
      "Title: Long feedback",
      "Label: bug",
      "",
      "Body:",
      ...Array.from({ length: 30 }, (_, index) => `Body line ${index + 1}`),
      "Complete preview tail",
    ].join("\n")
    let confirms = 0
    let cancels = 0
    const view = await testRender(
      () =>
        FeedbackConfirmation({
          title,
          confirmLabel,
          preview,
          onConfirm: () => {
            confirms += 1
          },
          onCancel: () => {
            cancels += 1
          },
        }),
      { width: 72, height: 18 },
    )

    try {
      const initial = await view.waitForFrame((frame) => frame.includes(title) && frame.includes(confirmLabel))
      expect(initial).toContain("Repository: hcrosse/opencode-pr-tracker")
      expect(initial).toContain("[Esc] Cancel")
      if (confirmLabel === "[Enter] Open issue") expect(initial).not.toContain("Send")
      expect(initial).not.toContain("Complete preview tail")

      view.mockInput.pressKey("END")
      await view.flush()
      const scrolled = view.captureCharFrame()
      expect(scrolled).toContain("Complete preview tail")
      expect(scrolled).toContain("[Esc] Cancel")
      expect(scrolled).toContain(confirmLabel)

      view.mockInput.pressEnter()
      await view.flush()
      view.mockInput.pressEscape()
      await Bun.sleep(30)
      await view.flush()
      expect(confirms).toBe(1)
      expect(cancels).toBe(1)
      view.mockInput.pressCtrlC()
      await view.flush()
      expect(cancels).toBe(2)
    } finally {
      view.renderer.destroy()
    }
  })
})
