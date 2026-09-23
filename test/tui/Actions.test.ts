import { describe, expect, test } from "bun:test"

import { Array as Arr, Effect, Option } from "effect"

import { actions, type Actions, type Services } from "../../src/tui/Actions.ts"
import { OpenFailed } from "../../src/tui/Browser.ts"
import {
  fakeTracker,
  scriptedTerminal,
  type Notice,
  type TerminalScript,
  type TrackerScript,
} from "../support/tui.ts"
import { bottom, entryOf, fresh, second, viewOf } from "../support/ui.tsx"

interface World {
  readonly terminal: TerminalScript
  readonly tracker: TrackerScript
  readonly opened: readonly string[]
  readonly run: (command: (commands: Actions) => Effect.Effect<void>) => Promise<void>
}

/** Commands over fakes; `openFails` makes the browser fail with that message. */
function world(openFails: Option.Option<string> = Option.none()): World {
  const terminal = scriptedTerminal()
  const tracker = fakeTracker()
  const opened: string[] = []

  const services: Services = {
    open: (url) =>
      Option.match(openFails, {
        onNone: () =>
          Effect.sync(() => {
            opened.push(url)
          }),
        onSome: (message) => Effect.fail(new OpenFailed({ message })),
      }),
    terminal: terminal.terminal,
    tracker: tracker.client,
  }

  const commands = actions(services)

  return {
    opened,
    run: async (command) => {
      await Effect.runPromise(command(commands))
    },
    terminal,
    tracker,
  }
}

const twoAttached = viewOf([
  entryOf(bottom, fresh(bottom, "Bottom")),
  entryOf(second, fresh(second, "Second")),
])

const nothingAttached: Notice = ["info", "No pull requests are attached."]

describe("commands without a session", () => {
  test("every command warns and makes no request", async () => {
    const setup = world()

    setup.terminal.leaveSession()
    await setup.run((commands) =>
      Effect.all([
        commands.attach(Option.some("123")),
        commands.open,
        commands.detach,
        commands.sync,
      ]),
    )

    expect(setup.tracker.calls).toEqual([])
    expect(setup.terminal.notices).toEqual(Arr.replicate(["warning", "Open a session first."], 4))
  })
})

describe("attach command", () => {
  test("attaches what was typed after the command, trimmed, without asking", async () => {
    const setup = world()

    await setup.run((commands) => commands.attach(Option.some("  123 ")))

    expect(setup.terminal.asked).toEqual([])
    expect(setup.tracker.calls).toEqual(["attach ses_test 123"])
    expect(setup.terminal.notices).toEqual([["success", "Attached 123."]])
  })

  test("shows why the tracker refused", async () => {
    const setup = world()

    setup.tracker.fail("A session can track at most 20 pull requests.")
    await setup.run((commands) => commands.attach(Option.some("123")))

    expect(setup.terminal.notices).toEqual([
      ["error", "A session can track at most 20 pull requests."],
    ])
  })
})

describe("attach dialog", () => {
  test("asks when nothing was typed, and does nothing when the dialog is dismissed", async () => {
    const setup = world()

    await setup.run((commands) => commands.attach(Option.some("  ")))

    expect(setup.terminal.asked).toEqual(["Attach pull request"])
    expect(setup.tracker.calls).toEqual([])
    expect(setup.terminal.notices).toEqual([])
  })

  test("attaches the answer to the dialog, trimmed", async () => {
    const setup = world()

    setup.terminal.answer("  github.com/acme/api/pull/7 ")
    await setup.run((commands) => commands.attach(Option.none()))

    expect(setup.tracker.calls).toEqual(["attach ses_test github.com/acme/api/pull/7"])
  })
})

describe("choosing an attached pull request", () => {
  test("open and detach report that nothing is attached, without a dialog", async () => {
    const setup = world()

    await setup.run((commands) => Effect.all([commands.open, commands.detach]))

    expect(setup.terminal.asked).toEqual([])
    expect(setup.terminal.notices).toEqual([nothingAttached, nothingAttached])
  })

  test("shows a failure to list the attachments instead of a dialog", async () => {
    const setup = world()

    setup.tracker.fail("The saved state cannot be read.")
    await setup.run((commands) => commands.detach)

    expect(setup.terminal.asked).toEqual([])
    expect(setup.terminal.notices).toEqual([["error", "The saved state cannot be read."]])
  })
})

describe("detach command", () => {
  test("offers the attached pull requests and detaches the chosen one", async () => {
    const setup = world()

    setup.tracker.show(twoAttached)
    setup.terminal.select(Option.some(1))
    await setup.run((commands) => commands.detach)

    expect(setup.terminal.asked).toEqual(["Detach pull request: acme/api#1, acme/api#2"])
    expect(setup.tracker.calls).toEqual([
      "list ses_test",
      "detach ses_test https://github.com/acme/api/pull/2",
    ])
    expect(setup.terminal.notices).toEqual([
      ["success", "Detached https://github.com/acme/api/pull/2."],
    ])
  })
})

describe("open command", () => {
  test("opens the chosen pull request quietly, and does nothing when dismissed", async () => {
    const setup = world()

    setup.tracker.show(twoAttached)
    setup.terminal.select(Option.some(0))
    setup.terminal.select(Option.none())
    await setup.run((commands) => Effect.all([commands.open, commands.open]))

    expect(setup.opened).toEqual(["https://github.com/acme/api/pull/1"])
    expect(setup.terminal.notices).toEqual([])
  })

  test("shows why the browser could not open", async () => {
    const setup = world(Option.some("Opening pull requests is not supported on win32."))

    setup.tracker.show(twoAttached)
    setup.terminal.select(Option.some(0))
    await setup.run((commands) => commands.open)

    expect(setup.terminal.notices).toEqual([
      ["error", "Opening pull requests is not supported on win32."],
    ])
  })
})

describe("sync command", () => {
  test("reports how many pull requests were synced", async () => {
    const setup = world()

    setup.tracker.show(twoAttached)
    await setup.run((commands) => commands.sync)

    expect(setup.tracker.calls).toEqual(["refresh ses_test"])
    expect(setup.terminal.notices).toEqual([["success", "Synced 2 pull requests."]])
  })

  test("warns when some pull requests could not be refreshed", async () => {
    const setup = world()

    setup.tracker.show(
      viewOf([
        entryOf(bottom, fresh(bottom, "Bottom")),
        entryOf(second, { _tag: "Unavailable", diagnostic: "GitHubUnavailable" }),
      ]),
    )
    await setup.run((commands) => commands.sync)

    expect(setup.terminal.notices).toEqual([
      ["warning", "Synced 2 pull requests; 1 could not be refreshed."],
    ])
  })

  test("reports that nothing is attached", async () => {
    const setup = world()

    await setup.run((commands) => commands.sync)

    expect(setup.terminal.notices).toEqual([nothingAttached])
  })
})
