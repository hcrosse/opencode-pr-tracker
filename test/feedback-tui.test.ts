import { describe, expect, test } from "bun:test"

import type {
  TuiDialogConfirmProps,
  TuiDialogPromptProps,
  TuiDialogSelectProps,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui"

import { createFeedbackCommand } from "../src/feedback-tui.jsx"
import type { ProcessRunner } from "../src/github.js"

type DialogView =
  | Readonly<{ kind: "select"; props: TuiDialogSelectProps }>
  | Readonly<{ kind: "prompt"; props: TuiDialogPromptProps }>
  | Readonly<{ kind: "confirm"; props: TuiDialogConfirmProps }>

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
  const api = {
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
  } as unknown as TuiPluginApi

  return {
    command: createFeedbackCommand(
      api,
      { runner, ...(options.platform === undefined ? {} : { platform: options.platform }) },
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
    expect(final.kind).toBe("confirm")
    expect(harness.processCalls).toEqual([])
    if (final.kind !== "confirm") throw new Error("expected final confirmation")
    final.props.onConfirm?.()
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
    await fillOtherFeedback(harness)
    await select(harness, "gh")
    await confirm(harness, true)
    await run

    expect(harness.processCalls[0]).toMatchObject({
      file: "gh",
      args: [
        "issue",
        "create",
        "--repo",
        "hcrosse/opencode-pr-tracker",
        "--title",
        "Documentation feedback",
        "--body",
        "## Details\n\nThe installation guide is clear.",
      ],
    })
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
    expect(includedFinal.kind).toBe("confirm")
    if (includedFinal.kind !== "confirm") throw new Error("expected final confirmation")
    expect(includedFinal.props.message).toContain(
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
    expect(declinedFinal.kind).toBe("confirm")
    if (declinedFinal.kind !== "confirm") throw new Error("expected final confirmation")
    expect(declinedFinal.props.message).not.toContain("## Diagnostics")
    declined.dismiss()
    await declinedRun
  })

  test("shows the exact immutable draft and browser action before delivery", async () => {
    const harness = createHarness({ platform: "darwin" })
    const run = harness.command.run()
    await fillBugFeedback(harness, false)
    await select(harness, "browser")
    const final = await harness.next()
    expect(final.kind).toBe("confirm")
    if (final.kind !== "confirm") throw new Error("expected final confirmation")

    expect(final.props.message).toBe(
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
    harness.dismiss()
    await run
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
      (harness) => confirm(harness, true),
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
    expect(final.kind).toBe("confirm")
    if (final.kind !== "confirm") throw new Error("expected final confirmation")
    const clearsBeforeAbort = harness.clearCalls()

    harness.controller.abort()
    await run
    final.props.onConfirm?.()
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
      message: "Unable to open feedback",
    },
    {
      name: "generic GitHub CLI failure",
      delivery: "gh",
      runner: async () => {
        throw processExecutionFailed(1, "network unavailable")
      },
      message: "Unable to submit feedback with GitHub CLI",
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
    await confirm(harness, true)
    await run

    expect(harness.toasts).toEqual([{ variant: "error", title: "Pull request tracker", message }])
  })

  test("uses unavailable release diagnostics without reading session or attachment state", async () => {
    const harness = createHarness()
    const run = harness.command.run()
    await fillOtherFeedback(harness, true)
    await select(harness, "browser")
    const final = await harness.next()
    expect(final.kind).toBe("confirm")
    if (final.kind !== "confirm") throw new Error("expected final confirmation")

    expect(final.props.message).toContain("- Plugin version: unavailable")
    expect(final.props.message).toContain("- Installation source: unavailable")
    harness.dismiss()
    await run
  })
})
