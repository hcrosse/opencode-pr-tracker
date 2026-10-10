import { describe, expect, test } from "bun:test"

import { Effect, Exit, type Schema } from "effect"

import { failed, type GitHubApi, type ItemResult } from "../../../src/ports/GitHub.ts"
import { httpClient, recordedPullRequest, runClient, tracker127 } from "../../support/github.ts"
import { found } from "../../support/lookup.ts"

/** The recorded #127 node with one completed check created at `createdAt`. */
const checkCreatedAt = (createdAt: string): Response =>
  Response.json({
    data: {
      pr0: found(
        Object.assign({}, recordedPullRequest, {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  __typename: "CheckRun",
                  checkSuite: { app: null, createdAt, id: "CS_a", workflowRun: null },
                  conclusion: "FAILURE",
                  name: "Lint",
                  status: "COMPLETED",
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          } satisfies Schema.Json,
        }),
      ),
    },
  })

const fetch127 = (github: GitHubApi): Effect.Effect<ItemResult | undefined, unknown> =>
  Effect.map(github.fetch([tracker127]), (results) => results.get(tracker127.url))

describe("GitHub answers the client cannot read", () => {
  test.each<readonly [string, () => Response]>([
    ["a check with a timestamp that does not parse", (): Response => checkCreatedAt("yesterday")],
    [
      "a check created on a day that does not exist",
      (): Response => checkCreatedAt("2026-02-30T08:00:00Z"),
    ],
    ["an answer without the pull request's alias", (): Response => Response.json({ data: {} })],
  ])("report %s as an invalid response, not missing", async (_name, respond) => {
    const result = await runClient({ http: httpClient(respond) }, fetch127)

    expect(result).toEqual(Exit.succeed(failed("InvalidResponse")))
  })

  test("still report a pull request GitHub answers as null as missing", async () => {
    const http = httpClient(() => Response.json({ data: { pr0: null } }))
    const result = await runClient({ http }, fetch127)

    expect(result).toEqual(Exit.succeed(failed("NotFound")))
  })
})
