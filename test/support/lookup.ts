/** Requests and answers in the shape of the client's pull request lookups. */
import { Option, Schema } from "effect"

import type { RequestBody } from "./github.ts"

const BatchData = Schema.Struct({
  data: Schema.Record(Schema.String, Schema.NullOr(Schema.Struct({ pullRequest: Schema.Json }))),
})

/** The pull request node answered under `alias` in a batch `response`, or null. */
export const answeredNode = (response: Schema.Json, alias: string): Schema.Json =>
  Option.match(Option.fromNullishOr(Schema.decodeUnknownSync(BatchData)(response).data[alias]), {
    onNone: () => null,
    onSome: (answer) => answer.pullRequest,
  })

/** What GitHub answers under an alias for a pull request `node` in a repository it found. */
export const found = (node: Schema.Json): Schema.Json => ({ pullRequest: node })

const ownerSuffix = "_owner"

/** The canonical URL of each pull request a batch request asks for, by alias. */
export function requested(body: RequestBody): ReadonlyMap<string, string> {
  const { variables } = body

  const aliases = Object.keys(variables).flatMap((name: string) =>
    name.endsWith(ownerSuffix) ? [name.slice(0, -ownerSuffix.length)] : [],
  )

  return new Map(
    aliases.map((alias: string) => {
      const [owner, repository, number] = ["owner", "name", "number"].map((field: string) =>
        String(variables[`${alias}_${field}`]),
      )

      return [alias, `https://github.com/${owner}/${repository}/pull/${number}`]
    }),
  )
}
