/**
 * Records GitHub GraphQL responses for the adapter tests, using the production query documents.
 * Run with `bun test/support/record-github-fixtures.ts`; it needs an authenticated `gh`.
 * Only public pull requests are recorded.
 */
import path from "node:path"

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Option, Schema } from "effect"

import { CommandRunner, layer as commandLayer } from "../../src/adapters/github/Command.ts"
import { alias, batch, continuation } from "../../src/adapters/github/Query.ts"

type Variables = Readonly<Record<string, string>>

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const PageInfo = Schema.Struct({
  endCursor: Schema.NullOr(Schema.String),
  hasNextPage: Schema.Boolean,
})

const ContextPages = Schema.Struct({
  data: Schema.Record(
    Schema.String,
    Schema.Struct({
      statusCheckRollup: Schema.NullOr(
        Schema.Struct({ contexts: Schema.Struct({ pageInfo: PageInfo }) }),
      ),
    }),
  ),
})

const post = Effect.fn("post")(function* (query: string, variables: Variables) {
  const runner = yield* CommandRunner

  const fields = Object.entries(variables).flatMap(([name, value]: readonly [string, string]) => [
    "-f",
    `${name}=${value}`,
  ])

  const output = yield* runner.run(
    "gh",
    ["api", "graphql", "-f", `query=${query}`, ...fields],
    process.cwd(),
  )

  return yield* decodeJson(output)
})

/** The cursor for the next page of check contexts under `key`, if there is one. */
function nextCursor(response: Schema.Json, key: string): Option.Option<string> {
  return Schema.decodeUnknownOption(ContextPages)(response).pipe(
    Option.flatMap(({ data }) => Option.fromNullishOr(data[key])),
    Option.flatMap((node) => Option.fromNullishOr(node.statusCheckRollup)),
    Option.filter((rollup) => rollup.contexts.pageInfo.hasNextPage),
    Option.flatMap((rollup) => Option.fromNullishOr(rollup.contexts.pageInfo.endCursor)),
  )
}

interface Pending {
  readonly url: string
  readonly key: string
  readonly pageSize: number
}

const pages = Effect.fn("pages")(function* (first: Schema.Json, { key, pageSize, url }: Pending) {
  const exchanges: { variables: Variables; response: Schema.Json }[] = []
  let cursor = nextCursor(first, key)

  while (Option.isSome(cursor)) {
    const variables = { cursor: cursor.value, url }
    const response = yield* post(continuation(pageSize), variables)

    exchanges.push({ response, variables })
    cursor = nextCursor(response, "resource")
  }

  return exchanges
})

const record = Effect.fn("record")(function* (
  name: string,
  urls: readonly string[],
  pageSize: number,
) {
  const fs = yield* FileSystem.FileSystem
  const variables = Object.fromEntries(urls.map((url, index) => [alias(index), url]))
  const first = yield* post(batch(urls.length, pageSize), variables)

  const continuations = yield* Effect.forEach(urls, (url: string, index: number) =>
    pages(first, { key: alias(index), pageSize, url }),
  )

  const exchanges = [{ response: first, variables }, ...continuations.flat()]
  const file = path.join(import.meta.dir, "..", "fixtures", "github", `${name}.json`)
  const recorded = { exchanges, pageSize, recordedAt: new Date().toISOString() }

  yield* fs.writeFileString(file, `${JSON.stringify(recorded, null, 2)}\n`)
})

const repository = "https://github.com/hcrosse/opencode-pr-tracker/pull"

const kubernetes = "https://github.com/kubernetes/kubernetes/pull"

const program = Effect.gen(function* () {
  yield* record("stack", [`${repository}/78`, `${repository}/79`], 100)
  yield* record(
    "standalone",
    [
      `${repository}/127`,
      `${repository}/120`,
      `${repository}/93`,
      "https://github.com/anomalyco/opencode/pull/50760",
      `${repository}/999999`,
    ],
    100,
  )
  yield* record("status-contexts", [`${kubernetes}/142335`, `${kubernetes}/142334`], 100)
  yield* record("paginated", [`${kubernetes}/142339`, `${repository}/127`], 5)
})

NodeRuntime.runMain(program.pipe(Effect.provide([NodeServices.layer, commandLayer])))
