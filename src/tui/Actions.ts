/** What the slash commands do, over a small port to the terminal and the tracker client. */
import { Effect, Option } from "effect"

import type { PullRequestRef } from "../domain/PullRequest.ts"
import type { View } from "../rpc.ts"
import type { OpenFailed } from "./Browser.ts"
import type { RequestFailed, TrackerClientApi } from "./Client.ts"

export type Variant = "info" | "success" | "warning" | "error"

export interface Choice<A> {
  readonly title: string
  readonly value: A
}

/** The terminal features the commands use. Dialogs succeed with `None` when dismissed. */
export interface Terminal {
  readonly session: () => Option.Option<string>
  readonly notify: (variant: Variant, message: string) => void
  readonly prompt: (title: string, placeholder: string) => Effect.Effect<Option.Option<string>>
  readonly choose: (
    title: string,
    choices: readonly Choice<PullRequestRef>[],
  ) => Effect.Effect<Option.Option<PullRequestRef>>
}

export interface Services {
  readonly terminal: Terminal
  readonly tracker: TrackerClientApi
  readonly open: (url: string) => Effect.Effect<void, OpenFailed>
}

export interface Actions {
  /** Attaches `input` when given, otherwise asks for a pull request. */
  readonly attach: (input: Option.Option<string>) => Effect.Effect<void>
  readonly open: Effect.Effect<void>
  readonly detach: Effect.Effect<void>
  readonly sync: Effect.Effect<void>
  /** Opens a pull request in the browser, reporting a failure. */
  readonly openPullRequest: (ref: PullRequestRef) => Effect.Effect<void>
}

type Notice = readonly [Variant, string]

const placeholder = "github.com/owner/repository/pull/123, or 123"

/** Runs `body` for the current session, or warns that there is none. */
function inSession(
  terminal: Terminal,
  body: (sessionID: string) => Effect.Effect<void>,
): Effect.Effect<void> {
  return Effect.suspend(() =>
    Option.match(terminal.session(), {
      onNone: () =>
        Effect.sync(() => {
          terminal.notify("warning", "Open a session first.")
        }),
      onSome: body,
    }),
  )
}

/** Shows the outcome of `effect`: its failure's message as an error, or `notice` of its value. */
function report<A>(
  terminal: Terminal,
  effect: Effect.Effect<A, RequestFailed | OpenFailed>,
  notice: (value: A) => Option.Option<Notice>,
): Effect.Effect<void> {
  return Effect.map(Effect.result(effect), (result) => {
    if (result._tag === "Failure") {
      terminal.notify("error", result.failure.message)

      return
    }

    for (const [variant, message] of Option.toArray(notice(result.success))) {
      terminal.notify(variant, message)
    }
  })
}

/** Asks which attached pull request to act on; `None` when none are attached or the dialog is dismissed. */
function pick(
  { terminal, tracker }: Services,
  sessionID: string,
  title: string,
): Effect.Effect<Option.Option<PullRequestRef>> {
  return Effect.result(tracker.list(sessionID)).pipe(
    Effect.flatMap((result) => {
      if (result._tag === "Failure") {
        terminal.notify("error", result.failure.message)

        return Effect.succeedNone
      }

      const { entries } = result.success

      if (entries.length === 0) {
        terminal.notify("info", "No pull requests are attached.")

        return Effect.succeedNone
      }

      return terminal.choose(
        title,
        entries.map((entry) => ({
          title: entry.ref.label,
          value: entry.ref,
        })),
      )
    }),
  )
}

const changed = (outcome: { readonly message: string }): Option.Option<Notice> =>
  Option.some(["success", outcome.message])

function syncedNotice(view: View): Option.Option<Notice> {
  const count = view.entries.length

  const failed = view.entries.filter(
    (entry) => entry.status._tag === "Stale" || entry.status._tag === "Unavailable",
  ).length

  if (count === 0) return Option.some(["info", "No pull requests are attached."])

  const synced = `Synced ${String(count)} ${count === 1 ? "pull request" : "pull requests"}`

  return Option.some(
    failed === 0
      ? ["success", `${synced}.`]
      : ["warning", `${synced}; ${String(failed)} could not be refreshed.`],
  )
}

/** What was typed after the command or into the dialog, without surrounding whitespace. */
const typedTarget = (text: string): Option.Option<string> =>
  Option.filter(Option.some(text.trim()), (trimmed) => trimmed !== "")

function attach(services: Services, input: Option.Option<string>): Effect.Effect<void> {
  const { terminal, tracker } = services

  return inSession(terminal, (sessionID) =>
    Option.match(Option.flatMap(input, typedTarget), {
      onNone: () =>
        Effect.map(
          terminal.prompt("Attach pull request", placeholder),
          Option.flatMap(typedTarget),
        ),
      onSome: (text) => Effect.succeedSome(text),
    }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (target) => report(terminal, tracker.attach(sessionID, target), changed),
        }),
      ),
    ),
  )
}

/** A command that acts on one attached pull request, chosen in a dialog. */
interface PickedAction<A> {
  readonly title: string
  readonly act: (
    sessionID: string,
    ref: PullRequestRef,
  ) => Effect.Effect<A, RequestFailed | OpenFailed>
  readonly notice: (value: A) => Option.Option<Notice>
}

function withPicked<A>(services: Services, action: PickedAction<A>): Effect.Effect<void> {
  return inSession(services.terminal, (sessionID) =>
    pick(services, sessionID, action.title).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (ref) => report(services.terminal, action.act(sessionID, ref), action.notice),
        }),
      ),
    ),
  )
}

export function actions(services: Services): Actions {
  const { terminal, tracker } = services

  return {
    attach: (input) => attach(services, input),
    detach: withPicked(services, {
      act: (sessionID, ref) => tracker.detach(sessionID, ref.url),
      notice: changed,
      title: "Detach pull request",
    }),
    open: withPicked(services, {
      act: (_, ref) => services.open(ref.url),
      notice: Option.none,
      title: "Open pull request",
    }),
    openPullRequest: (ref) => report(terminal, services.open(ref.url), Option.none),
    sync: inSession(terminal, (sessionID) =>
      report(terminal, tracker.refresh(sessionID), syncedNotice),
    ),
  }
}
