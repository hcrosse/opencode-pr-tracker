import { describe, expect, test } from "bun:test"

import { Schema } from "effect"

import { ContextNode, toCheck } from "../../../src/adapters/github/Contexts.ts"

const decoded = (node: Schema.Json): ContextNode => Schema.decodeUnknownSync(ContextNode)(node)

const run =
  (status: string, conclusion: string | null, createdAt = "2026-08-26T13:47:20Z") =>
  (): ContextNode =>
    decoded({
      __typename: "CheckRun",
      checkSuite: { app: null, createdAt, id: "CS_a", workflowRun: null },
      conclusion,
      name: "Lint",
      status,
    })

const status =
  (state: string, createdAt = "2026-09-23T08:00:00Z") =>
  (): ContextNode =>
    decoded({ __typename: "StatusContext", context: "ci/build", createdAt, state })

describe("check states GitHub added later", () => {
  test.each<readonly [string, () => ContextNode]>([
    ["a completed run with a new conclusion", run("COMPLETED", "SUCCESS_WITH_NOTES")],
    ["a run with a new status", run("PAUSED", null)],
    ["a running run with a new conclusion", run("IN_PROGRESS", "SUCCESS_WITH_NOTES")],
    ["a new status with a known conclusion", run("PAUSED", "SUCCESS")],
    ["a completed run without a conclusion", run("COMPLETED", null)],
    ["a status context with a new state", status("CANCELLED")],
  ])("read %s as unknown, not passed, pending or ignored", (_name, node) => {
    expect(toCheck(node()).outcome).toBe("unknown")
  })
})

describe("check timestamps GitHub sent malformed", () => {
  test.each([
    "",
    "yesterday",
    "2026-09-23",
    "2026-09-23T08:00:00",
    "2026-09-23T08:00:00+02:00",
    "2026-02-30T08:00:00Z",
    "2025-02-29T08:00:00Z",
    "2026-09-23T24:00:00Z",
    "2026-13-45T99:00:00Z",
  ])("reject %p rather than order the check as another time", (createdAt) => {
    expect(status("SUCCESS", createdAt)).toThrow()
    expect(run("COMPLETED", "SUCCESS", createdAt)).toThrow()
  })
})

describe("check timestamps GitHub sent well formed", () => {
  test.each<readonly [string, readonly [number, number]]>([
    ["2024-02-29T00:00:00Z", [1_709_164_800, 0]],
    ["2026-09-23T08:00:00.5Z", [1_790_150_400, 500_000_000]],
    ["2026-09-23T08:00:00.123456789Z", [1_790_150_400, 123_456_789]],
  ])("read %p as its instant", (createdAt, generation) => {
    expect(toCheck(status("SUCCESS", createdAt)()).generation).toEqual(generation)
  })
})
