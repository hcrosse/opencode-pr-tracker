/** GitHub's UTC timestamps, read as check generations. */
import { Effect, Option, Schema, SchemaGetter, SchemaIssue } from "effect"

import type { Generation } from "../../domain/Checks.ts"

const timestamp = /^(?<seconds>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d+))?Z$/u

/**
 * `[epochSeconds, nanoseconds]`, so runs created in the same second still order correctly. None
 * unless `createdAt` is an ISO 8601 UTC date and time that exists, such as `2026-09-23T08:00:00Z`
 * or `2026-09-23T08:00:00.5Z`: its whole seconds must read back unchanged, so a day or hour that
 * would roll over into the next, such as February 30, is rejected.
 */
export function generationOf(createdAt: string): Option.Option<Generation> {
  const match = timestamp.exec(createdAt)
  const groups = match === null ? {} : (match.groups ?? {})
  const seconds = groups["seconds"] ?? ""
  const millis = Date.parse(`${seconds}Z`)
  const nanoseconds = Number((groups["fraction"] ?? "").padEnd(9, "0").slice(0, 9))
  const exists = Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 19) === seconds

  return exists ? Option.some([millis / 1000, nanoseconds]) : Option.none()
}

/** A UTC timestamp as a generation. A timestamp that is not one fails the response. */
export const CreatedAt = Schema.String.pipe(
  Schema.decodeTo(Schema.Tuple([Schema.Number, Schema.Number]), {
    decode: SchemaGetter.transformOrFail((createdAt: string, options) =>
      Option.match(generationOf(createdAt), {
        onNone: () =>
          Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: "not a UTC date and time" },
              createdAt,
              options,
            ),
          ),
        onSome: (generation) => Effect.succeed(generation),
      }),
    ),
    encode: SchemaGetter.forbidden(() => "Check timestamps are never sent to GitHub"),
  }),
)
