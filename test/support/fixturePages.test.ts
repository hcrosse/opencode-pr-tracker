import { describe, expect, test } from "bun:test"

import { Array as Arr, Effect, Exit, Option, type Schema } from "effect"

import type { Exchange } from "./exchange.ts"
import { nextCursor, UnreadablePage } from "./fixturePages.ts"
import { fixture } from "./github.ts"

const pageInfo = (hasNextPage: boolean, endCursor: string | null): Schema.Json => ({
  data: {
    pr0: {
      pullRequest: { statusCheckRollup: { contexts: { pageInfo: { endCursor, hasNextPage } } } },
    },
  },
})

const nothingFollowed: ReadonlySet<string> = new Set()

interface Followed {
  readonly key: string
  readonly number: number
}

/** The response recorded for `cursor` of pull request `number`, or null when none was recorded. */
const recordedPage = (
  exchanges: readonly Exchange[],
  number: number,
  cursor: string,
): Schema.Json =>
  Option.match(
    Arr.findFirst(
      exchanges,
      (exchange: Exchange) =>
        exchange.variables["cursor"] === cursor && exchange.variables["number"] === number,
    ),
    { onNone: () => null, onSome: (exchange: Exchange) => exchange.response },
  )

/** Follows the cursors for `key` from the first exchange through the recorded continuations. */
const followRecorded = Effect.fn("fixturePages.followRecorded")(function* (
  exchanges: readonly Exchange[],
  { key, number }: Followed,
) {
  const first = Option.match(Arr.head(exchanges), {
    onNone: () => null,
    onSome: (exchange: Exchange) => exchange.response,
  })

  const cursors = new Set<string>()
  let cursor = yield* nextCursor(first, key, cursors)

  while (Option.isSome(cursor)) {
    cursors.add(cursor.value)

    const page = recordedPage(exchanges, number, cursor.value)

    cursor = yield* nextCursor(page, "repository", cursors)
  }

  return [...cursors]
})

describe("following recorded pages of check contexts", () => {
  test.each([
    ["paginated", { key: "pr0", number: 142_865 }, ["NQ", "MTA", "MTU", "MjA", "MjU"]],
    ["paginated", { key: "pr1", number: 127 }, ["NQ", "MTA"]],
    ["status-contexts", { key: "pr0", number: 142_875 }, []],
    ["status-contexts", { key: "pr1", number: 142_334 }, []],
    ["standalone", { key: "pr0", number: 127 }, []],
    ["standalone", { key: "pr4", number: 999_999 }, []],
  ] as const)("follows the pages recorded in %s for %o", (name, pullRequest, cursors) => {
    expect(Effect.runSync(followRecorded(fixture(name), pullRequest))).toEqual([...cursors])
  })
})

function expectUnreadable(
  next: Effect.Effect<Option.Option<string>, UnreadablePage>,
  problem: UnreadablePage["problem"],
): void {
  const exit = Effect.runSyncExit(next)

  expect(Exit.findErrorOption(exit)).toMatchObject({ value: { key: "pr0", problem } })
  expect(Exit.findErrorOption(exit).pipe(Option.getOrNull)).toBeInstanceOf(UnreadablePage)
}

describe("the next page of check contexts", () => {
  test.each([
    ["a missing repository", { data: { pr0: null } }],
    ["a missing pull request", { data: { pr0: { pullRequest: null } } }],
    ["no status rollup", { data: { pr0: { pullRequest: { statusCheckRollup: null } } } }],
    ["a last page", pageInfo(false, "Y3Vyc29y")],
  ] as const)("is absent for %s", (_name, response) => {
    expect(Effect.runSync(nextCursor(response, "pr0", nothingFollowed))).toEqual(Option.none())
  })

  test("is the end cursor when GitHub reports another page with a new cursor", () => {
    const followed = new Set(["TlE"])

    expect(Effect.runSync(nextCursor(pageInfo(true, "Y3Vyc29y"), "pr0", followed))).toEqual(
      Option.some("Y3Vyc29y"),
    )
  })

  test.each([
    ["a response without data", { data: null }, "Malformed"],
    ["a response without an answer for the alias", { data: {} }, "Malformed"],
    ["a page with an unexpected shape", { data: { pr0: { pullRequest: 1 } } }, "Malformed"],
    ["another page without a cursor", pageInfo(true, null), "MissingCursor"],
  ] as const)("fails for %s", (_name, response, problem) => {
    expectUnreadable(nextCursor(response, "pr0", nothingFollowed), problem)
  })

  test("fails for a cursor already followed, which would page forever", () => {
    const followed = new Set(["TlE", "Y3Vyc29y"])

    expectUnreadable(nextCursor(pageInfo(true, "Y3Vyc29y"), "pr0", followed), "RepeatedCursor")
  })
})
