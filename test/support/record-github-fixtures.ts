/**
 * Records GitHub GraphQL responses for the adapter tests, using the production query documents.
 * Run with `bun test/support/record-github-fixtures.ts`; it needs an authenticated `gh`.
 * Only public pull requests are recorded.
 */
import path from "node:path"

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { DateTime, Effect, FileSystem, Option, Result, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"

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
import { queryDigest } from "./exchange.ts"
import { nextCursor } from "./fixturePages.ts"

const endpoint = "https://api.github.com/graphql"

/**
 * Posts straight to GitHub rather than through `gh api graphql`, which fails without printing the
 * response when it carries GraphQL errors, as it does for a missing pull request. A non-2xx
 * answer fails.
 */
const post = Effect.fn("GitHubFixtures.post")(function* (query: string, variables: Variables) {
  const runner = yield* CommandRunner
  const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const token = (yield* runner.run("gh", ["auth", "token"], process.cwd())).trim()

  const request = HttpClientRequest.post(endpoint).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.bodyJsonUnsafe({ query, variables }),
  )

  const response = yield* http.execute(request)

  return yield* HttpClientResponse.schemaBodyJson(Schema.Json)(response)
})

interface Pending {
  readonly ref: PullRequestRef
  readonly key: string
  readonly pageSize: number
}

const pages = Effect.fn("GitHubFixtures.pages")(function* (
  first: Schema.Json,
  { key, pageSize, ref }: Pending,
) {
  const query = continuation(pageSize)
  const exchanges: { queryDigest: string; variables: Variables; response: Schema.Json }[] = []
  const followed = new Set<string>()
  let cursor = yield* nextCursor(first, key, followed)

  while (Option.isSome(cursor)) {
    followed.add(cursor.value)

    const variables = continuationVariables(ref, cursor.value)
    const response = yield* post(query, variables)

    exchanges.push({ queryDigest: queryDigest(query), response, variables })
    cursor = yield* nextCursor(response, "repository", followed)
  }

  return exchanges
})

const record = Effect.fn("GitHubFixtures.record")(function* (
  name: string,
  urls: readonly string[],
  pageSize: number,
) {
  const fs = yield* FileSystem.FileSystem
  const refs = urls.map((url: string) => Result.getOrThrow(parsePullRequestUrl(url)))
  const variables = batchVariables(refs)
  const query = batch(refs.length, "all", pageSize)
  const first = yield* post(query, variables)

  const continuations = yield* Effect.forEach(refs, (ref: PullRequestRef, index: number) =>
    pages(first, { key: alias(index), pageSize, ref }),
  )

  const exchanges = [
    { queryDigest: queryDigest(query), response: first, variables },
    ...continuations.flat(),
  ]

  const file = path.join(import.meta.dir, "..", "fixtures", "github", `${name}.json`)
  const recordedAt = DateTime.formatIso(yield* DateTime.now)
  const recorded = { exchanges, pageSize, recordedAt }

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

NodeRuntime.runMain(
  program.pipe(Effect.provide([NodeServices.layer, commandLayer, FetchHttpClient.layer])),
)
