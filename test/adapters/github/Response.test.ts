import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Array as Arr, Order, Schema } from "effect"

import { ContextNode, generationOf, toCheck } from "../../../src/adapters/github/Contexts.ts"
import { classifyCi, type CheckOutcome } from "../../../src/domain/Checks.ts"

/** A check run as recorded from hcrosse/opencode-pr-tracker#127. */
const recordedRun = {
  __typename: "CheckRun",
  checkSuite: {
    app: { id: "MDM6QXBwMTUzNjg=" },
    createdAt: "2026-08-26T13:47:20Z",
    id: "CS_kwDOTs91es8AAAAB",
    workflowRun: {
      event: "pull_request",
      runAttempt: 1,
      runNumber: 216,
      workflow: { id: "W_kwDOTs91es4Twdqa" },
    },
  },
  conclusion: "SUCCESS",
  name: "Lint",
  status: "COMPLETED",
} as const

interface RunFields {
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
  readonly runNumber: number
  readonly runAttempt: number
  readonly suiteCreatedAt: string
  readonly suite: string
  readonly workflow: boolean
  readonly workflowId: string
  readonly event: string
  /** Whether GitHub reports the app that created the check suite. */
  readonly app: boolean
}

const recordedFields: RunFields = {
  conclusion: recordedRun.conclusion,
  event: recordedRun.checkSuite.workflowRun.event,
  name: recordedRun.name,
  runAttempt: recordedRun.checkSuite.workflowRun.runAttempt,
  runNumber: recordedRun.checkSuite.workflowRun.runNumber,
  status: recordedRun.status,
  suiteCreatedAt: recordedRun.checkSuite.createdAt,
  suite: recordedRun.checkSuite.id,
  workflow: true,
  workflowId: recordedRun.checkSuite.workflowRun.workflow.id,
  app: true,
}

const decoded = (node: Schema.Json): ContextNode => Schema.decodeUnknownSync(ContextNode)(node)

/** The recorded check run with some fields changed, as the client decodes it. */
function run(changes: Partial<RunFields>): ContextNode {
  const fields: RunFields = Object.assign({}, recordedFields, changes)

  const workflowRun = {
    event: fields.event,
    runAttempt: fields.runAttempt,
    runNumber: fields.runNumber,
    workflow: { id: fields.workflowId },
  }

  return decoded({
    __typename: "CheckRun",
    checkSuite: {
      app: fields.app ? recordedRun.checkSuite.app : null,
      createdAt: fields.suiteCreatedAt,
      id: fields.suite,
      workflowRun: fields.workflow ? workflowRun : null,
    },
    conclusion: fields.conclusion,
    name: fields.name,
    status: fields.status,
  })
}

const status = (context: string, state: string, createdAt: string): ContextNode =>
  decoded({ __typename: "StatusContext", context, createdAt, state })

const ci = (nodes: readonly ContextNode[]): string =>
  classifyCi(nodes.map((node: ContextNode) => toCheck(node)))

describe("check run outcomes", () => {
  test.each<readonly [string, CheckOutcome]>([
    ["SUCCESS", "passed"],
    ["FAILURE", "failed"],
    ["CANCELLED", "failed"],
    ["TIMED_OUT", "failed"],
    ["ACTION_REQUIRED", "failed"],
    ["STARTUP_FAILURE", "failed"],
    ["STALE", "failed"],
    ["NEUTRAL", "ignored"],
    ["SKIPPED", "ignored"],
  ])("maps a completed run concluding %s to %s", (conclusion, outcome) => {
    expect(toCheck(run({ conclusion })).outcome).toBe(outcome)
  })

  test.each(["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"])(
    "maps a %s run to pending",
    (runStatus) => {
      expect(toCheck(run({ conclusion: null, status: runStatus })).outcome).toBe("pending")
    },
  )
})

describe("which runs count", () => {
  test("a rerun attempt replaces the failed attempt it reran", () => {
    expect(ci([run({ conclusion: "FAILURE", runAttempt: 1 }), run({ runAttempt: 2 })])).toBe(
      "passed",
    )
  })

  test("a later workflow run replaces an earlier one", () => {
    expect(ci([run({ conclusion: "CANCELLED", runNumber: 216 }), run({ runNumber: 217 })])).toBe(
      "passed",
    )
  })

  test("a passing job does not hide a failing job of the same run", () => {
    expect(ci([run({ conclusion: "FAILURE", name: "Test" }), run({ name: "Lint" })])).toBe("failed")
  })
})

describe("which runs count across workflow runs", () => {
  test("a later workflow run replaces jobs it no longer has", () => {
    const nodes = [
      run({ conclusion: "FAILURE", name: "Test", runNumber: 216 }),
      run({ name: "Lint", runNumber: 217 }),
    ]

    expect(ci(nodes)).toBe("passed")
  })

  // A matrix job cancelled before its matrix is computed keeps the unexpanded name.
  test("a rerun replaces a cancelled run's unexpanded matrix job", () => {
    const nodes = [
      run({ name: "Build", runNumber: 216 }),
      run({ conclusion: "CANCELLED", name: "Test (${{ matrix.shard }})", runNumber: 216 }),
      run({ conclusion: "CANCELLED", name: "Deploy", runNumber: 216 }),
      run({ conclusion: "FAILURE", name: "Required checks", runNumber: 216 }),
      run({ name: "Build", runNumber: 217 }),
      run({ name: "Test (unit)", runNumber: 217 }),
      run({ name: "Test (integration)", runNumber: 217 }),
      run({ conclusion: "SKIPPED", name: "Deploy", runNumber: 217 }),
      run({ name: "Required checks", runNumber: 217 }),
    ]

    expect(ci(nodes)).toBe("passed")
  })

  test("a later run of another workflow or event does not replace a failure", () => {
    const failing = run({ conclusion: "FAILURE", runNumber: 216 })

    expect(ci([failing, run({ runNumber: 217, workflowId: "W_other" })])).toBe("failed")
    expect(ci([failing, run({ event: "push", runNumber: 217 })])).toBe("failed")
  })
})

describe("which runs count across suites", () => {
  test("a check outside workflows is replaced by the same check in a newer suite", () => {
    const older = run({
      conclusion: "FAILURE",
      suiteCreatedAt: "2026-08-26T13:00:00Z",
      workflow: false,
    })

    const newer = run({ suiteCreatedAt: "2026-08-26T13:05:00Z", workflow: false })

    expect(ci([newer, older])).toBe("passed")
  })
})

describe("which checks are one check", () => {
  test("checks whose app GitHub does not report are kept apart by suite", () => {
    const failing = run({
      app: false,
      conclusion: "FAILURE",
      suite: "CS_a",
      suiteCreatedAt: "2026-08-26T13:00:00Z",
      workflow: false,
    })

    const passing = run({
      app: false,
      suite: "CS_b",
      suiteCreatedAt: "2026-08-26T13:05:00Z",
      workflow: false,
    })

    expect(ci([passing, failing])).toBe("failed")
  })

  test("status contexts differing only in case are one check", () => {
    const nodes = [
      status("CI/Build", "FAILURE", "2026-09-23T08:00:00Z"),
      status("ci/build", "SUCCESS", "2026-09-23T08:01:00Z"),
    ]

    expect(ci(nodes)).toBe("passed")
  })
})

const instants = gs.tuples(
  gs.integers({ maxValue: 4_102_444_800_000, minValue: 0 }),
  gs.integers({ maxValue: 999_999_999, minValue: 0 }),
)

/** An ISO timestamp for the whole second of `milliseconds` plus `nanoseconds`. */
const iso = ([milliseconds, nanoseconds]: readonly [number, number]): string =>
  new Date(Math.floor(milliseconds / 1000) * 1000)
    .toISOString()
    .replace(".000Z", `.${String(nanoseconds).padStart(9, "0")}Z`)

const generationOrder = Arr.makeOrder(Order.Number)

describe("run timestamps", () => {
  test("order the same way as the instants they record, down to the nanosecond", () => {
    hegel.test((tc) => {
      const left = tc.draw(instants)
      const right = tc.draw(instants)

      const expected = Math.sign(
        Math.floor(left[0] / 1000) - Math.floor(right[0] / 1000) || left[1] - right[1],
      )

      expect<number>(generationOrder(generationOf(iso(left)), generationOf(iso(right)))).toBe(
        expected,
      )
    })
  })

  test("orders a whole-second timestamp before a later fraction of the same second", () => {
    expect(
      generationOrder(generationOf("2026-09-23T08:00:00Z"), generationOf("2026-09-23T08:00:00.5Z")),
    ).toBe(-1)
  })
})
