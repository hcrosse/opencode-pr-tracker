import { Effect, Exit, Layer } from "effect"

import { layer as storageLayer } from "../../src/adapters/Storage.ts"
import { layer as trackerLayer, Tracker, type TrackerApi } from "../../src/application/Tracker.ts"
import type { PullRequestInput, PullRequestRef } from "../../src/domain/PullRequest.ts"
import type { Tracking } from "../../src/domain/Tracking.ts"
import {
  memoryStorage,
  openState,
  reported,
  ScriptedGitHub,
  standalone,
  type GitHubScript,
  type StorageFake,
} from "./application.ts"
import { ref, refs } from "./monitor.ts"

export { ref, refs }

export const byUrl = (pullRequest: PullRequestRef): PullRequestInput => ({
  _tag: "Reference",
  ref: pullRequest,
})

export const numbers = (tracking: Tracking): number[] =>
  tracking.map((attachment) => attachment.ref.number)

export interface World {
  readonly github: GitHubScript
  readonly storage: StorageFake
}

/** Pull requests 1 to 30 in acme/api are open and standalone. */
export function world(): World {
  const github = new ScriptedGitHub()

  for (let number = 1; number <= 30; number += 1) {
    github.script(ref(number), reported(ref(number), openState, standalone))
  }

  return { github, storage: memoryStorage() }
}

export async function run<A, E>(
  setup: World,
  use: (tracker: TrackerApi) => Effect.Effect<A, E>,
): Promise<Exit.Exit<A, E>> {
  const layer = trackerLayer.pipe(
    Layer.provide([setup.github.layer, storageLayer(setup.storage.storage)]),
  )

  const result = await Effect.runPromise(Effect.exit(Tracker.use(use).pipe(Effect.provide(layer))))

  return result
}
