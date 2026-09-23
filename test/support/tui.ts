import { Array as Arr, Effect, Option } from "effect"
import { constVoid } from "effect/Function"

import type { Changed, View } from "../../src/rpc.ts"
import type { Terminal, Variant } from "../../src/tui/Actions.ts"
import { RequestFailed, type TrackerClientApi } from "../../src/tui/Client.ts"
import { viewOf } from "./ui.tsx"

export type Notice = readonly [Variant, string]

/** How tests drive and observe a scripted terminal. */
export interface TerminalScript {
  readonly terminal: Terminal
  readonly notices: readonly Notice[]
  /** Every dialog shown, in order: prompts by title, selections as `title: choice, …`. */
  readonly asked: readonly string[]
  readonly leaveSession: () => void
  /** Queues the next prompt's answer; with none queued, prompts are dismissed. */
  readonly answer: (text: string) => void
  /** Queues the next selection; `None` dismisses it, as does an empty queue. */
  readonly select: (index: Option.Option<number>) => void
}

/** A selection dialog that records itself as `title: choice, …` and answers with `next`. */
function selectionDialog(
  record: (dialog: string) => void,
  next: () => Option.Option<number>,
): Terminal["choose"] {
  return (title, choices) =>
    Effect.sync(() => {
      record(`${title}: ${choices.map((choice) => choice.title).join(", ")}`)

      return Option.flatMap(next(), (index) =>
        Option.map(Arr.get(choices, index), (choice) => choice.value),
      )
    })
}

/** A prompt that records its title and answers with `next`. */
function promptDialog(
  record: (dialog: string) => void,
  next: () => Option.Option<string>,
): Terminal["prompt"] {
  return (title) =>
    Effect.sync(() => {
      record(title)

      return next()
    })
}

export function scriptedTerminal(): TerminalScript {
  const notices: Notice[] = []
  const asked: string[] = []
  const answers: string[] = []
  const selections: Option.Option<number>[] = []
  let session = Option.some("ses_test")

  const record = (dialog: string): void => {
    asked.push(dialog)
  }

  const terminal: Terminal = {
    choose: selectionDialog(record, () => Option.flatten(Option.fromNullishOr(selections.shift()))),
    notify: (variant: Variant, message: string) => {
      notices.push([variant, message])
    },
    prompt: promptDialog(record, () => Option.fromNullishOr(answers.shift())),
    session: () => session,
  }

  return {
    answer: (text) => {
      answers.push(text)
    },
    asked,
    leaveSession: () => {
      session = Option.none()
    },
    notices,
    select: (index) => {
      selections.push(index)
    },
    terminal,
  }
}

/** How tests drive and observe a fake tracker client. */
export interface TrackerScript {
  readonly client: TrackerClientApi
  /** Every request, as `method sessionID [target]`. */
  readonly calls: readonly string[]
  readonly show: (view: View) => void
  /** Makes every later request fail with `message`. */
  readonly fail: (message: string) => void
}

export function fakeTracker(): TrackerScript {
  const calls: string[] = []
  let view = viewOf([])
  let failure = Option.none<string>()

  const respond = <A>(call: string, value: () => A): Effect.Effect<A, RequestFailed> =>
    Effect.suspend(() => {
      calls.push(call)

      return Option.match(failure, {
        onNone: () => Effect.succeed(value()),
        onSome: (message) => Effect.fail(new RequestFailed({ message })),
      })
    })

  const changed = (message: string) => (): Changed => ({ message, view })

  return {
    calls,
    client: {
      attach: (sessionID, target) =>
        respond(`attach ${sessionID} ${target}`, changed(`Attached ${target}.`)),
      detach: (sessionID, target) =>
        respond(`detach ${sessionID} ${target}`, changed(`Detached ${target}.`)),
      list: (sessionID) => respond(`list ${sessionID}`, () => view),
      onUpdate: () => constVoid,
      refresh: (sessionID) => respond(`refresh ${sessionID}`, () => view),
    },
    fail: (message) => {
      failure = Option.some(message)
    },
    show: (next) => {
      view = next
    },
  }
}
