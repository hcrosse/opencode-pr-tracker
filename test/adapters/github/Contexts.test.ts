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
