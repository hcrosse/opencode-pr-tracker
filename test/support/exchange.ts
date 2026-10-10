/** Recorded GitHub exchanges, keyed by the query and variables they were recorded with. */
import { createHash } from "node:crypto"

import { Schema } from "effect"

export const Variables = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number]))

export const Exchange = Schema.Struct({
  queryDigest: Schema.String,
  response: Schema.Json,
  variables: Variables,
})

export type Exchange = typeof Exchange.Type

/**
 * A digest of a GraphQL document. Each recorded exchange keeps the digest of the query it was
 * recorded with, so a fixture recorded with a different query stops replaying.
 */
export const queryDigest = (query: string): string =>
  createHash("sha256").update(query).digest("hex")

/** The replay key of a request: its query digest and its variables in name order. */
export const exchangeKey = (digest: string, variables: typeof Variables.Type): string =>
  JSON.stringify([
    digest,
    ...Object.entries(variables).toSorted(
      ([left]: readonly [string, unknown], [right]: readonly [string, unknown]) =>
        left.localeCompare(right),
    ),
  ])
