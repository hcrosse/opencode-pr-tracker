import { describe, expect, test } from "bun:test"

import { Effect, Exit, Option, Result, type Schema } from "effect"

import { continuation } from "../../../src/adapters/github/Query.ts"
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

const effect8431: PullRequestRef = Result.getOrThrow(
  parsePullRequestUrl("https://github.com/Effect-TS/effect/pull/8431"),
)

/** GitHub's repository lookup, which matches owner and name in any case, but numbers exactly. */
const repositoryLookup = (body: RequestBody): Response => {
  const owner = String(body.variables["pr0_owner"] ?? "").toLowerCase()
  const name = String(body.variables["pr0_name"] ?? "").toLowerCase()

  return owner === "effect-ts" && name === "effect" && body.variables["pr0_number"] === 8431
    ? Response.json({ data: { pr0: found(recordedPullRequest) } })
    : Response.json({ data: { pr0: null }, errors: [{ path: ["pr0"], type: "NOT_FOUND" }] })
}

const tagOf = (item: ItemResult | undefined): string =>
  Option.match(Option.fromNullishOr(item), { onNone: () => "missing", onSome: (some) => some._tag })

describe("GitHub client lookup of a repository named with capitals", () => {
  test("reports a pull request whose URL was given in mixed case", async () => {
    const http = httpClient(repositoryLookup)
    const result = await runClient({ http }, (github: GitHubApi) => github.fetch([effect8431]))

    expect(effect8431.url).toBe("https://github.com/effect-ts/effect/pull/8431")
    expect(Exit.map(result, (results) => tagOf(results.get(effect8431.url)))).toEqual(
      Exit.succeed("Reported"),
    )
  })

  test("looks pull requests up by repository and number, not by URL", async () => {
    const http = httpClient(repositoryLookup)

    await runClient({ http }, (github: GitHubApi) => github.fetch([effect8431]))

    const sent = http.requests.map((request: RequestBody) => request.query).join("\n")
    const pages = continuation()

    expect(sent).toContain(
      "pr0: repository(owner: $pr0_owner, name: $pr0_name) { pullRequest(number: $pr0_number)",
    )
    expect(pages).toContain("repository(owner: $owner, name: $name) { pullRequest(number: $number)")
    expect([sent, pages].some((query) => query.includes("resource("))).toBe(false)
  })
})

const notFound: ItemResult = { _tag: "Failed", charged: false, diagnostic: "NotFound" }

/** What the client reports for #8431, and a found #127 beside it, when GitHub answers `pr0` so. */
async function besideFound(
  pr0: Schema.Json,
  errors: readonly Schema.Json[],
): Promise<Exit.Exit<readonly (ItemResult | undefined)[], unknown>> {
  const http = httpClient(() =>
    Response.json({ data: { pr0, pr1: found(recordedPullRequest) }, errors }),
  )

  const result = await runClient({ http }, (github: GitHubApi) =>
    Effect.map(github.fetch([effect8431, tracker127]), (results) => [
      results.get(effect8431.url),
      results.get(tracker127.url),
    ]),
  )

  return result
}

describe("GitHub client lookup of a pull request GitHub does not find", () => {
  test.each<readonly [string, Schema.Json, Schema.Json]>([
    ["a missing pull request", { pullRequest: null }, ["pr0", "pullRequest"]],
    ["a missing repository", null, ["pr0"]],
  ])("reports %s as not found, and only it", async (_name, pr0, path) => {
    const result = await besideFound(pr0, [{ path, type: "NOT_FOUND" }])

    expect(Exit.map(result, (results) => results.map((item) => tagOf(item)))).toEqual(
      Exit.succeed(["Failed", "Reported"]),
    )
    expect(Exit.map(result, (results) => results[0])).toEqual(Exit.succeed(notFound))
  })

  test("reports a repository answer without a pull request field as invalid", async () => {
    const result = await besideFound({}, [])

    expect(Exit.map(result, (results) => results[0])).toEqual(
      Exit.succeed({ _tag: "Failed", charged: false, diagnostic: "InvalidResponse" }),
    )
  })
})
