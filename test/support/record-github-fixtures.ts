/**
 * Records GitHub GraphQL responses for the adapter tests, using the production query documents.
 * Run with `bun test/support/record-github-fixtures.ts`; it needs an authenticated `gh`.
 * Only public pull requests are recorded.
 */
import path from "node:path"

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, FileSystem, Option, Result, Schema } from "effect"

import { CommandRunner, layer as commandLayer } from "../../src/adapters/Command.ts"
import type { Variables } from "../../src/adapters/github/Post.ts"
import {
  alias,
  batch,
  batchVariables,
  continuation,
  continuationVariables,
} from "../../src/adapters/github/Query.ts"
import { parsePullRequestUrl, type PullRequestRef } from "../../src/domain/PullRequest.ts"

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))

const PageInfo = Schema.Struct({
  endCursor: Schema.NullOr(Schema.String),
  hasNextPage: Schema.Boolean,
})

const ContextPages = Schema.Struct({
  data: Schema.Record(
    Schema.String,
    Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            statusCheckRollup: Schema.NullOr(
              Schema.Struct({ contexts: Schema.Struct({ pageInfo: PageInfo }) }),
            ),
          }),
        ),
      }),
    ),
  ),
})

/**
 * Posts straight to GitHub rather than through `gh api graphql`, which fails without printing the
 * response when it carries GraphQL errors, as it does for a missing pull request.
 */
const post = Effect.fn("post")(function* (query: string, variables: Variables) {
  const runner = yield* CommandRunner
  const token = (yield* runner.run("gh", ["auth", "token"], process.cwd())).trim()

  const output = yield* Effect.tryPromise(async () => {
    const response = await fetch("https://api.github.com/graphql", {
      body: JSON.stringify({ query, variables }),
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
    })

    if (!response.ok) throw new Error(`GitHub answered ${String(response.status)}`)

    return response.text()
  })

  return yield* decodeJson(output)
})

/** The cursor for the next page of check contexts under `key`, if there is one. */
function nextCursor(response: Schema.Json, key: string): Option.Option<string> {
  return Schema.decodeUnknownOption(ContextPages)(response).pipe(
    Option.flatMap(({ data }) => Option.fromNullishOr(data[key])),
    Option.flatMap((repository) => Option.fromNullishOr(repository.pullRequest)),
    Option.flatMap((node) => Option.fromNullishOr(node.statusCheckRollup)),
    Option.filter((rollup) => rollup.contexts.pageInfo.hasNextPage),
    Option.flatMap((rollup) => Option.fromNullishOr(rollup.contexts.pageInfo.endCursor)),
  )
}

interface Pending {
  readonly ref: PullRequestRef
  readonly key: string
  readonly pageSize: number
}

const pages = Effect.fn("pages")(function* (first: Schema.Json, { key, pageSize, ref }: Pending) {
  const exchanges: { variables: Variables; response: Schema.Json }[] = []
  let cursor = nextCursor(first, key)

  while (Option.isSome(cursor)) {
    const variables = continuationVariables(ref, cursor.value)
    const response = yield* post(continuation(pageSize), variables)

    exchanges.push({ response, variables })
    cursor = nextCursor(response, "repository")
  }

  return exchanges
})

const record = Effect.fn("record")(function* (
  name: string,
  urls: readonly string[],
  pageSize: number,
) {
  const fs = yield* FileSystem.FileSystem
  const refs = urls.map((url: string) => Result.getOrThrow(parsePullRequestUrl(url)))
  const variables = batchVariables(refs)
  const first = yield* post(batch(refs.length, "all", pageSize), variables)

  const continuations = yield* Effect.forEach(refs, (ref: PullRequestRef, index: number) =>
    pages(first, { key: alias(index), pageSize, ref }),
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
  yield* record("mixed-case", ["https://github.com/Effect-TS/effect/pull/8431"], 100)
  yield* record("status-contexts", [`${kubernetes}/142875`, `${kubernetes}/142334`], 100)
  yield* record("paginated", [`${kubernetes}/142865`, `${repository}/127`], 5)
})

NodeRuntime.runMain(program.pipe(Effect.provide([NodeServices.layer, commandLayer])))
