import { describe, expect, test } from "bun:test"

import { Effect, Exit, Logger, Option, Schema } from "effect"

import type { PullRequestState } from "../../../src/domain/Snapshot.ts"
import type { GitHubApi, ItemResult } from "../../../src/ports/GitHub.ts"
import { httpClient, recordedPullRequest, runClient, tracker127 } from "../../support/github.ts"
import { found } from "../../support/lookup.ts"

/** A check run that completed with `conclusion`, created at `createdAt`. */
const checkRun = (conclusion: string, createdAt: string): Schema.Json => ({
  __typename: "CheckRun",
  checkSuite: { app: null, createdAt, id: "CS_a", workflowRun: null },
  conclusion,
  name: "Lint",
  status: "COMPLETED",
})

const rollup = (...nodes: readonly Schema.Json[]): Schema.Json => ({
  contexts: { nodes: [...nodes], pageInfo: { endCursor: null, hasNextPage: false } },
})

/** The recorded #127 node with `fields` replaced, answered as GitHub would. */
const answering = (fields: Readonly<Record<string, Schema.Json>>): Response =>
  Response.json({ data: { pr0: found(Object.assign({}, recordedPullRequest, fields)) } })

/** Values GitHub might add later to the enumerations the client reads. */
const added = {
  mergeStateStatus: "QUEUED",
  reviewDecision: "ESCALATED",
  statusCheckRollup: rollup(checkRun("SUCCESS_WITH_NOTES", "2026-08-26T13:47:20Z")),
}

const Warning = Schema.fromJsonString(
  Schema.Struct({
    annotations: Schema.Struct({
      field: Schema.String,
      pullRequest: Schema.String,
      value: Schema.String,
    }),
    level: Schema.Literal("WARN"),
  }),
)

type Logged = typeof Warning.Type.annotations

interface Fetched {
  readonly result: Option.Option<ItemResult>
  readonly warnings: readonly Logged[]
}

/** Fetches #127 twice, returning the first result and the warnings logged across both. */
const fetchLogged = (github: GitHubApi): Effect.Effect<Fetched, unknown> =>
  Effect.suspend(() => {
    const lines: string[] = []

    const capture = Logger.map(Logger.formatJson, (line: string) => {
      lines.push(line)
    })

    return github.fetch([tracker127]).pipe(
      Effect.tap(github.fetch([tracker127])),
      Effect.map((results): Fetched => ({
        result: Option.fromNullishOr(results.get(tracker127.url)),
        warnings: lines.map((line: string) => Schema.decodeUnknownSync(Warning)(line).annotations),
      })),
      Effect.provide(Logger.layer([capture])),
    )
  })

const stateOf = (result: Option.Option<ItemResult>): Option.Option<PullRequestState> =>
  Option.flatMap(result, (item: ItemResult) =>
    item._tag === "Reported" ? Option.some(item.report.snapshot.state) : Option.none(),
  )

describe("GitHub values the client does not know", () => {
  test("read as unknown, and are logged once with the value GitHub sent", async () => {
    const http = httpClient(() => answering(added))
    const result = await runClient({ http }, fetchLogged)
    const fetched = Exit.isSuccess(result) ? result.value : { result: Option.none(), warnings: [] }

    expect(stateOf(fetched.result)).toMatchObject(
      Option.some({
        _tag: "Open",
        behind: "unknown",
        ci: "unknown",
        review: { decision: "unknown" },
      }),
    )

    const pullRequest = tracker127.url

    expect(fetched.warnings).toEqual([
      { field: "PullRequest.mergeStateStatus", pullRequest, value: "QUEUED" },
      { field: "CheckRun.conclusion", pullRequest, value: "SUCCESS_WITH_NOTES" },
      { field: "PullRequest.reviewDecision", pullRequest, value: "ESCALATED" },
    ])
  })
})
