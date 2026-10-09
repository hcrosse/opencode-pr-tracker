import { describe, expect, test } from "bun:test"

import { Option, Result } from "effect"

import {
  toReport,
  toMembership,
  type PullRequestNode,
} from "../../../src/adapters/github/Response.ts"
import { parsePullRequestUrl } from "../../../src/domain/PullRequest.ts"

interface StackEntry {
  readonly position: number
  readonly url: string
  readonly state?: "OPEN" | "CLOSED" | "MERGED"
}

const stackOf = (
  size: number,
  hasNextPage: boolean,
  entries: readonly StackEntry[],
): PullRequestNode["stack"] => ({
  entries: {
    nodes: entries.map((entry: StackEntry) => ({
      position: entry.position,
      pullRequest: { state: entry.state ?? "OPEN", url: entry.url },
    })),
    pageInfo: { hasNextPage },
  },
  id: "stack",
  size,
})

const withStack = (stack: PullRequestNode["stack"]): PullRequestNode => ({
  __typename: "PullRequest",
  isDraft: false,
  mergeStateStatus: "CLEAN",
  mergeable: "MERGEABLE",
  stack,
  state: "OPEN",
  statusCheckRollup: null,
  title: "Title",
  url: "https://github.com/acme/api/pull/1",
})

const first = { position: 1, url: "https://github.com/acme/api/pull/1" }

const second = { position: 2, url: "https://github.com/acme/api/pull/2" }

describe("Stack membership", () => {
  test.each<readonly [string, PullRequestNode["stack"]]>([
    ["more members than GitHub returned", stackOf(3, false, [first, second])],
    ["more entries on another page", stackOf(2, true, [first, second])],
    [
      "a member URL that is not a pull request",
      stackOf(2, false, [first, { position: 2, url: "https://github.com/acme/api/issues/2" }]),
    ],
  ])("is unknown when a Stack has %s", (_name, stack) => {
    expect(toMembership(withStack(stack))).toEqual(Option.none())
  })

  test("orders members by position, bottom first, whatever order GitHub lists them", () => {
    const membership = toMembership(withStack(stackOf(2, false, [second, first])))

    const numbers = Option.map(membership, (found) =>
      found._tag === "Stack" ? found.members.map((member) => member.number) : [],
    )

    expect(numbers).toEqual(Option.some([1, 2]))
  })
})

describe("Stack member states", () => {
  const named = Result.getOrThrow(parsePullRequestUrl(first.url))

  const nonOpenOf = (stack: PullRequestNode["stack"]): readonly string[] =>
    toReport(named, withStack(stack), []).nonOpenMembers

  test("reports the members GitHub lists as merged or closed, by canonical URL", () => {
    const stack = stackOf(4, false, [
      { position: 1, state: "MERGED", url: "https://github.com/acme/api/pull/1" },
      second,
      { position: 3, state: "CLOSED", url: "github.com/Acme/API/pull/3" },
      { position: 4, state: "OPEN", url: "https://github.com/acme/api/pull/4" },
    ])

    expect(nonOpenOf(stack)).toEqual([
      "https://github.com/acme/api/pull/1",
      "https://github.com/acme/api/pull/3",
    ])
  })

  test("reports none for a standalone pull request", () => {
    expect(nonOpenOf(null)).toEqual([])
  })
})
