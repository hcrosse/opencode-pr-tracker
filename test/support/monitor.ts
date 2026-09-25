import { Array as Arr, Effect, Exit, Layer, Option, Result } from "effect"
import { TestClock } from "effect/testing"

import { layer as storageLayer } from "../../src/adapters/Storage.ts"
import {
  layer as monitorLayer,
  Monitor,
  type MonitorApi,
  type SessionView,
} from "../../src/application/Monitor.ts"
import { layer as trackerLayer, Tracker, type TrackerApi } from "../../src/application/Tracker.ts"
import { parsePullRequestUrl, type PullRequestRef } from "../../src/domain/PullRequest.ts"
import type { PullRequestState } from "../../src/domain/Snapshot.ts"
import type { Membership } from "../../src/domain/StackLayout.ts"
import {
  memoryStorage,
  openState,
  reported,
  ScriptedGitHub,
  standalone,
  type GitHubScript,
  type StorageFake,
} from "./application.ts"

export const ref = (number: number): PullRequestRef =>
  Result.getOrThrow(parsePullRequestUrl(`github.com/acme/api/pull/${String(number)}`))

export const [open, closed, merged, other] = [ref(1), ref(2), ref(3), ref(4)]

export interface App {
  readonly monitor: MonitorApi
  readonly tracker: TrackerApi
}

/** Runs `use` with a Monitor over a scripted GitHub, starting at test time zero. */
export async function run<A, E>(
  github: GitHubScript,
  use: (app: App) => Effect.Effect<A, E>,
  storage: StorageFake = memoryStorage(),
): Promise<Exit.Exit<A, E>> {
  const layer = monitorLayer.pipe(
    Layer.provideMerge(trackerLayer),
    Layer.provide([github.layer, storageLayer(storage.storage)]),
  )

  const program = Effect.gen(function* () {
    const app: App = { monitor: yield* Monitor, tracker: yield* Tracker }

    return yield* use(app)
  })

  const result = await Effect.runPromise(
    Effect.exit(program.pipe(Effect.provide([layer, TestClock.layer()]))),
  )

  return result
}

/** #1 and #4 are open, #2 closed, #3 merged. */
export function scripted(): GitHubScript {
  const github = new ScriptedGitHub()

  const states: readonly (readonly [PullRequestRef, PullRequestState])[] = [
    [open, openState],
    [closed, { _tag: "Closed" }],
    [merged, { _tag: "Merged" }],
    [other, openState],
  ]

  for (const [pullRequest, state] of states) {
    github.script(pullRequest, reported(pullRequest, state, standalone))
  }

  return github
}

/** Attaches pull requests to a session and marks the session in use. */
export const watching = (
  app: App,
  sessionID: string,
  refs: readonly PullRequestRef[],
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    for (const pullRequest of refs) {
      yield* app.tracker.attach(sessionID, { _tag: "Reference", ref: pullRequest }, "/work")
    }

    yield* app.monitor.view(sessionID)
  })

/** The pull request numbers of each fetch made after `from`. */
export const fetchedSince = (github: GitHubScript, from: number): number[][] =>
  github.fetches.slice(from).map((urls) => urls.map((url) => Number(url.split("/").at(-1))))

export const statusOf = (app: App): Effect.Effect<string, unknown> =>
  Effect.map(app.monitor.view("a"), (view: SessionView) =>
    Option.match(Arr.head(view.entries), {
      onNone: () => "none",
      onSome: (entry) => entry.status._tag,
    }),
  )

/** Stack `id` with the pull requests `numbers`, bottom first. */
export const stackOf = (id: string, numbers: readonly number[]): Membership => {
  const [head = 1, ...tail] = numbers

  return { _tag: "Stack", id, members: [ref(head), ...tail.map((number) => ref(number))] }
}

/** Scripts each of `numbers` as open, with `membership`. */
export function scriptAll(
  github: Readonly<GitHubScript>,
  numbers: readonly number[],
  membership: Membership,
): void {
  for (const number of numbers) {
    github.script(ref(number), reported(ref(number), openState, membership))
  }
}

/** The pull request numbers of session "a", in display order. */
export const numbersOf = (app: App): Effect.Effect<readonly number[], unknown> =>
  Effect.map(app.monitor.view("a"), (view: SessionView) =>
    view.entries.map((entry) => entry.ref.number),
  )
