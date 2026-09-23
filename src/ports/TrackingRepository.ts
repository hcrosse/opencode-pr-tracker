import { Context, Schema, type Effect } from "effect"

import type { Tracking } from "../domain/Tracking.ts"

/** A session's stored attachments could not be read. They are kept as they are, not discarded. */
export class StoredStateInvalid extends Schema.TaggedError<StoredStateInvalid>()(
  "StoredStateInvalid",
  {
    sessionID: Schema.String,
  },
) {}

export interface TrackingRepositoryApi {
  /** The session's attachments; empty when nothing is stored. */
  readonly load: (sessionID: string) => Effect.Effect<Tracking, StoredStateInvalid>
  readonly save: (sessionID: string, tracking: Tracking) => Effect.Effect<void>
  readonly remove: (sessionID: string) => Effect.Effect<void>
}

export class TrackingRepository extends Context.Service<
  TrackingRepository,
  TrackingRepositoryApi
>()("opencode-pr-tracker/TrackingRepository") {}
