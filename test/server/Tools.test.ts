import { describe, expect, test } from "bun:test"

import { Result, Schema } from "effect"

import { parsePullRequestInput } from "../../src/domain/PullRequest.ts"
import { PullRequestArgument, targetOf } from "../../src/server/Tools.ts"

const decode = Schema.decodeUnknownSync(PullRequestArgument)

describe("pull request tool argument", () => {
  test.each([
    ["a URL", "github.com/acme/api/pull/7", "github.com/acme/api/pull/7"],
    ["a number as text", "7", "7"],
    ["a JSON number", 7, "7"],
  ])("accepts %s", (_name, value: string | number, target: string) => {
    expect(targetOf(decode({ pull_request: value }))).toBe(target)
  })

  test("rejects a boolean before it reaches the tracker", () => {
    expect(() => decode({ pull_request: true })).toThrow()
  })

  test.each([
    ["a fractional number", 7.5],
    ["zero", 0],
    ["a negative number", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("leaves the tracker to reject %s", (_name, value: number) => {
    const target = targetOf(decode({ pull_request: value }))

    expect(Result.isFailure(parsePullRequestInput(target))).toBe(true)
  })

  // OpenCode runs checks with its own copy of effect, where they reject every value.
  test("declares no checks, which OpenCode would fail", () => {
    const [text, number] = PullRequestArgument.fields.pull_request.members

    expect(text.ast.checks).toBeUndefined()
    expect(number.ast.checks).toBeUndefined()
  })
})
