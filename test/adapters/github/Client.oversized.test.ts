import { describe, expect, test } from "bun:test"

import { Exit, Result } from "effect"

import { parsePullRequestUrl, type PullRequestRef } from "../../../src/domain/PullRequest.ts"
import type { GitHubApi, ItemResult } from "../../../src/ports/GitHub.ts"
import {
  httpClient,
  recordedPullRequest,
  runClient,
  tracker127,
  type RequestBody,
} from "../../support/github.ts"
import { found } from "../../support/lookup.ts"

/** One past the largest GraphQL `Int`, so GitHub rejects any query that passes it. */
const oversized: PullRequestRef = Result.getOrThrow(
  parsePullRequestUrl("https://github.com/acme/api/pull/2147483648"),
)

const notFound: ItemResult = { _tag: "Failed", charged: false, diagnostic: "NotFound" }

const answering = (): Response => Response.json({ data: { pr0: found(recordedPullRequest) } })

describe("GitHub client with a pull request numbered beyond a GraphQL Int", () => {
  test("reports it not found without asking, and still asks for the others", async () => {
    const http = httpClient(answering)

    const result = await runClient({ http }, (github: GitHubApi) =>
      github.fetch([oversized, tracker127]),
    )

    expect(Exit.map(result, (results) => results.get(oversized.url))).toEqual(
      Exit.succeed(notFound),
    )
    expect(Exit.map(result, (results) => [...results.keys()])).toEqual(
      Exit.succeed([tracker127.url, oversized.url]),
    )
    expect(Exit.isSuccess(result) ? result.value.get(tracker127.url) : notFound).toMatchObject({
      _tag: "Reported",
    })
    expect(http.requests.map((request: RequestBody) => request.variables)).toEqual([
      { pr0_name: "opencode-pr-tracker", pr0_number: 127, pr0_owner: "hcrosse" },
    ])
    expect(http.requests.some((request) => request.query.includes("pr1"))).toBe(false)
  })

  test("sends no request when it asks only for such pull requests", async () => {
    const http = httpClient(answering)
    const result = await runClient({ http }, (github: GitHubApi) => github.fetch([oversized]))

    expect(Exit.map(result, (results) => [...results.values()])).toEqual(Exit.succeed([notFound]))
    expect(http.requests).toHaveLength(0)
  })
})
