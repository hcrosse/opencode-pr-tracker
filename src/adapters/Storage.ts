import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Array as Arr, Effect, Layer, Option, Result, Schema } from "effect"

import { parsePullRequestUrl } from "../domain/PullRequest.ts"
import { Attachment, maximumAttachments, type Tracking } from "../domain/Tracking.ts"
import { StoredStateInvalid, TrackingRepository } from "../ports/TrackingRepository.ts"

/** The stored form of a session's attachments. Bump `version` for incompatible changes. */
const Stored = Schema.Struct({
  pullRequests: Schema.Array(Schema.Struct({ attachedAt: Schema.Int, url: Schema.String })).check(
    Schema.isMaxLength(maximumAttachments),
  ),
  version: Schema.Literal(1),
})

type Stored = typeof Stored.Type

const keyOf = (sessionID: string): string => `session/${sessionID}`

function toTracking(stored: Stored): Option.Option<Tracking> {
  const attachments = stored.pullRequests.map((entry) =>
    Result.map(
      parsePullRequestUrl(entry.url),
      (ref) => new Attachment({ attachedAt: entry.attachedAt, ref }),
    ),
  )

  const valid = attachments.flatMap((attachment) => Option.toArray(Result.getSuccess(attachment)))
  const unique = Arr.dedupeWith(valid, (left, right) => left.ref.url === right.ref.url)

  return unique.length === stored.pullRequests.length ? Option.some(unique) : Option.none()
}

function toStored(tracking: Tracking): Stored {
  return {
    pullRequests: tracking.map((attachment) => ({
      attachedAt: attachment.attachedAt,
      url: attachment.ref.url,
    })),
    version: 1,
  }
}

/** Attachments kept in plugin storage, one key per session. */
export function layer(storage: StorageDomain): Layer.Layer<TrackingRepository> {
  return Layer.succeed(
    TrackingRepository,
    TrackingRepository.of({
      load: (sessionID) =>
        storage.get(keyOf(sessionID)).pipe(
          Effect.flatMap((value) =>
            Option.match(Option.fromNullishOr(value), {
              onNone: () => Effect.succeed<Tracking>([]),
              onSome: (json) =>
                Schema.decodeUnknownOption(Stored)(json).pipe(
                  Option.flatMap(toTracking),
                  Option.match({
                    onNone: () => Effect.fail(new StoredStateInvalid({ sessionID })),
                    onSome: (tracking) => Effect.succeed(tracking),
                  }),
                ),
            }),
          ),
        ),
      remove: (sessionID) => storage.remove(keyOf(sessionID)),
      save: (sessionID, tracking) => storage.set(keyOf(sessionID), toStored(tracking)),
    }),
  )
}
