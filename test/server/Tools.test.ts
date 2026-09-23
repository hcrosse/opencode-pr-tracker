import { describe, expect, test } from "bun:test"

import { Schema } from "effect"

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

  test.each([
    ["a boolean", true],
    ["a fractional number", 7.5],
  ])("rejects %s before it reaches the tracker", (_name, value: boolean | number) => {
    expect(() => decode({ pull_request: value })).toThrow()
  })

  test("describes the argument to agents as text or a whole number", () => {
    const { schema } = Schema.toJsonSchemaDocument(PullRequestArgument)

    expect(schema).toMatchObject({
      properties: { pull_request: { anyOf: [{ type: "string" }, { type: "integer" }] } },
    })
  })
})
