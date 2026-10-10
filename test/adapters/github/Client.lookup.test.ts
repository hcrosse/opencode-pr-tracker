import { describe, expect, test } from "bun:test"

import { Effect, Exit, Option, Result, type Schema } from "effect"

import { parsePullRequestUrl, type PullRequestRef } from "../../../src/domain/PullRequest.ts"
import { ItemResult, type GitHubApi } from "../../../src/ports/GitHub.ts"
import {
  acmeRef,
  httpClient,
  recordedPullRequest,
  runClient,
  tracker127,
} from "../../support/github.ts"
import { found } from "../../support/lookup.ts"

/** One past the largest GraphQL `Int`, which GitHub answers as a pull request it cannot find. */
const oversized: PullRequestRef = Result.getOrThrow(
  parsePullRequestUrl("https://github.com/acme/api/pull/2147483648"),
)

const notFound = ItemResult.Failed({ charged: false, diagnostic: "NotFound" })

const tagOf = (item: ItemResult | undefined): string =>
  Option.match(Option.fromNullishOr(item), { onNone: () => "missing", onSome: (some) => some._tag })

/** GitHub's answer for `ref` as `pr0` and a found #127 as `pr1`, in one batch. */
interface Answered {
  readonly ref: PullRequestRef
  readonly pr0: Schema.Json
  readonly errors: readonly Schema.Json[]
}

/** What the client reports for the pull request asked as `pr0`, and for #127 beside it. */
async function besideFound({
  errors,
  pr0,
  ref,
}: Answered): Promise<Exit.Exit<readonly (ItemResult | undefined)[], unknown>> {
  const http = httpClient(() =>
    Response.json({ data: { pr0, pr1: found(recordedPullRequest) }, errors }),
  )

  const result = await runClient({ http }, (github: GitHubApi) =>
    Effect.map(github.fetch([ref, tracker127]), (results) => [
      results.get(ref.url),
      results.get(tracker127.url),
    ]),
  )

  return result
}

const missingPullRequest = { pullRequest: null }

const unfound: readonly (readonly [string, Answered])[] = [
  [
    "a missing pull request",
    {
      errors: [{ path: ["pr0", "pullRequest"], type: "NOT_FOUND" }],
      pr0: missingPullRequest,
      ref: acmeRef(1),
    },
  ],
  [
    "a missing pull request answered without errors",
    { errors: [], pr0: missingPullRequest, ref: acmeRef(1) },
  ],
  [
    "a missing repository",
    { errors: [{ path: ["pr0"], type: "NOT_FOUND" }], pr0: null, ref: acmeRef(1) },
  ],
  [
    "a pull request numbered beyond a GraphQL Int",
    {
      errors: [{ path: ["pr0", "pullRequest"], type: "NOT_FOUND" }],
      pr0: missingPullRequest,
      ref: oversized,
    },
  ],
]

describe("GitHub client lookup of a pull request GitHub does not find", () => {
  test.each(unfound)("reports %s as not found, and only it", async (_name, answered: Answered) => {
    const result = await besideFound(answered)

    expect(Exit.map(result, (results) => results.map((item) => tagOf(item)))).toEqual(
      Exit.succeed(["Failed", "Reported"]),
    )
    expect(Exit.map(result, (results) => results[0])).toEqual(Exit.succeed(notFound))
  })

  test("reports a repository answer without a pull request field as invalid", async () => {
    const result = await besideFound({ errors: [], pr0: {}, ref: acmeRef(1) })

    expect(Exit.map(result, (results) => results[0])).toEqual(
      Exit.succeed(ItemResult.Failed({ charged: false, diagnostic: "InvalidResponse" })),
    )
  })
})
