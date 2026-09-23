import { describe, expect, test } from "bun:test"

import { Effect, Exit, Result, Schema } from "effect"

import { PullRequestNode } from "../../../src/adapters/github/Response.ts"
import { parsePullRequestUrl, type PullRequestRef } from "../../../src/domain/PullRequest.ts"
import type { Diagnostic } from "../../../src/domain/Snapshot.ts"
import type { GitHubApi, ItemResult } from "../../../src/ports/GitHub.ts"
import {
  httpClient,
  recordedNode,
  recordedPullRequest,
  runClient,
  tracker127,
  type RequestBody,
} from "../../support/github.ts"

const ref = (number: number): PullRequestRef =>
  Result.getOrThrow(parsePullRequestUrl(`github.com/acme/api/pull/${String(number)}`))

const fetchOne = (github: GitHubApi): Effect.Effect<ReadonlyMap<string, ItemResult>, unknown> =>
  github.fetch([ref(1)])

describe("GitHub client failures of one pull request", () => {
  test("reports a GraphQL error on one alias for that pull request only", async () => {
    const http = httpClient(() =>
      Response.json({
        data: { pr0: recordedPullRequest, pr1: null },
        errors: [{ path: ["pr1"], type: "FORBIDDEN" }],
      }),
    )

    const result = await runClient({ http }, (github: GitHubApi) =>
      github.fetch([tracker127, ref(2)]),
    )

    const results = Exit.isSuccess(result) ? [...result.value.values()] : []

    expect(results.map((item: ItemResult) => item._tag)).toEqual(["Reported", "Failed"])
    expect(results[1]).toEqual({ _tag: "Failed", diagnostic: "NotFound" })
  })

  test.each([
    ["an internal error", "INTERNAL"],
    ["an inaccessible error", "FORBIDDEN"],
  ])(
    "reports %s that names no pull request as invalid for every one",
    async (_name, type: string) => {
      const http = httpClient(() =>
        Response.json({ data: { pr0: recordedPullRequest }, errors: [{ type }] }),
      )

      const result = await runClient({ http }, (github: GitHubApi) => github.fetch([tracker127]))

      expect(Exit.map(result, (results) => [...results.values()])).toEqual(
        Exit.succeed([{ _tag: "Failed", diagnostic: "InvalidResponse" }]),
      )
    },
  )
})

describe("GitHub client failures in a pull request's data", () => {
  test("reports a broken page of checks for that pull request only", async () => {
    const paged = recordedNode("paginated", "pr1")

    const http = httpClient((body: RequestBody) =>
      "pr0" in body.variables
        ? Response.json({ data: { pr0: paged } })
        : Response.json({ data: { resource: null } }),
    )

    const result = await runClient({ http }, (github: GitHubApi) => github.fetch([tracker127]))

    expect(Exit.map(result, (results) => results.get(tracker127.url))).toEqual(
      Exit.succeed({ _tag: "Failed", diagnostic: "InvalidResponse" }),
    )
    expect(http.requests).toHaveLength(2)
  })

  test("reports an unexpected pull request shape as an invalid response", async () => {
    const http = httpClient(() =>
      Response.json({ data: { pr0: { __typename: "PullRequest", url: 7 } } }),
    )

    const result = await runClient({ http }, fetchOne)

    expect(Exit.map(result, (results) => results.get(ref(1).url))).toEqual(
      Exit.succeed({ _tag: "Failed", diagnostic: "InvalidResponse" }),
    )
  })
})

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

/** A later page of checks as GitHub returns it. */
interface LaterPage {
  readonly resource: {
    readonly statusCheckRollup: {
      readonly contexts: {
        readonly nodes: readonly never[]
        readonly pageInfo: { readonly endCursor: string | null; readonly hasNextPage: boolean }
      }
    }
  }
}

/** A later page with no checks of its own; with a cursor, it claims more checks after it. */
const laterPage = (cursor: string | null): LaterPage => ({
  resource: {
    statusCheckRollup: {
      contexts: { nodes: [], pageInfo: { endCursor: cursor, hasNextPage: cursor !== null } },
    },
  },
})

const lastPage = laterPage(null)

/** The result for #127 when the first request answers with `first` and every later one with `later`. */
async function resultFor(
  first: PullRequestNode,
  later: () => Response,
): Promise<Exit.Exit<ItemResult | undefined, unknown>> {
  const http = httpClient((_body, count: number) =>
    count === 1 ? Response.json({ data: { pr0: first } }) : later(),
  )

  const result = await runClient({ http }, (github) =>
    Effect.map(github.fetch([tracker127]), (results) => results.get(tracker127.url)),
  )

  return result
}

interface PageCase {
  readonly first: PullRequestNode
  readonly later: () => Response
  readonly diagnostic: Diagnostic
}

describe("GitHub client on further pages of checks", () => {
  test.each<readonly [string, PageCase]>([
    [
      "a later page that fails, keeping its diagnostic",
      {
        diagnostic: "GitHubUnavailable",
        first: withNextPage("c1"),
        later: (): Response => new Response("bad gateway", { status: 502 }),
      },
    ],
    [
      "a later page that carries GraphQL errors",
      {
        diagnostic: "InvalidResponse",
        first: withNextPage("c1"),
        later: (): Response =>
          Response.json({ data: lastPage, errors: [{ path: ["resource"], type: "INTERNAL" }] }),
      },
    ],
    [
      "a page that claims more checks without a cursor to them",
      {
        diagnostic: "InvalidResponse",
        first: withNextPage(null),
        later: (): Response => Response.json({ data: lastPage }),
      },
    ],
    [
      "a later page that repeats the cursor it was fetched with",
      {
        diagnostic: "InvalidResponse",
        first: withNextPage("c1"),
        later: (): Response => Response.json({ data: laterPage("c1") }),
      },
    ],
  ])("fails the pull request on %s", async (_name, { diagnostic, first, later }: PageCase) => {
    expect(await resultFor(first, later)).toEqual(Exit.succeed({ _tag: "Failed", diagnostic }))
  })
})
