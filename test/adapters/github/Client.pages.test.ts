import { describe, expect, test } from "bun:test"

import { Effect, Exit, Layer, Result, Schema } from "effect"

import { layer as clientLayer } from "../../../src/adapters/github/Client.ts"
import { PullRequestNode } from "../../../src/adapters/github/Response.ts"
import { parsePullRequestUrl } from "../../../src/domain/PullRequest.ts"
import { GitHub, type ItemResult } from "../../../src/ports/GitHub.ts"
import { fixedCommands, fixedToken, httpClient, recordedNode } from "../../support/github.ts"

const tracker127 = Result.getOrThrow(
  parsePullRequestUrl("github.com/hcrosse/opencode-pr-tracker/pull/127"),
)

const recorded = JSON.stringify(recordedNode("standalone", "pr0"))

/** #127 as recorded, but claiming a further page of checks after `cursor`. */
const withNextPage = (cursor: string | null): PullRequestNode =>
  Schema.decodeUnknownSync(PullRequestNode)(
    JSON.parse(
      recorded.replace(
        '"hasNextPage":false,"endCursor":"MTE"',
        `"hasNextPage":true,"endCursor":${JSON.stringify(cursor)}`,
      ),
    ),
  )

const lastPage = {
  resource: {
    statusCheckRollup: {
      contexts: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } },
    },
  },
}

/** The result for #127 when the first request answers with `first` and every later one with `later`. */
async function resultFor(
  first: PullRequestNode,
  later: () => Response,
): Promise<Exit.Exit<ItemResult | undefined, unknown>> {
  const http = httpClient((_body, count: number) =>
    count === 1 ? Response.json({ data: { pr0: first } }) : later(),
  )

  const layer = clientLayer.pipe(
    Layer.provide([http.layer, fixedToken().layer, fixedCommands({}).layer]),
  )

  const result = await Effect.runPromise(
    Effect.exit(
      GitHub.use((github) =>
        Effect.map(github.fetch([tracker127]), (results) => results.get(tracker127.url)),
      ).pipe(Effect.provide(layer)),
    ),
  )

  return result
}

describe("GitHub client on further pages of checks", () => {
  test("keeps the diagnostic of a further page that fails", async () => {
    const result = await resultFor(
      withNextPage("c1"),
      () => new Response("bad gateway", { status: 502 }),
    )

    expect(result).toEqual(Exit.succeed({ _tag: "Failed", diagnostic: "GitHubUnavailable" }))
  })

  test("rejects a further page that carries GraphQL errors", async () => {
    const result = await resultFor(withNextPage("c1"), () =>
      Response.json({ data: lastPage, errors: [{ path: ["resource"], type: "INTERNAL" }] }),
    )

    expect(result).toEqual(Exit.succeed({ _tag: "Failed", diagnostic: "InvalidResponse" }))
  })

  test("rejects a page that claims more checks without a cursor to them", async () => {
    const result = await resultFor(withNextPage(null), () => Response.json({ data: lastPage }))

    expect(result).toEqual(Exit.succeed({ _tag: "Failed", diagnostic: "InvalidResponse" }))
  })
})
