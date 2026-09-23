import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"

import { classifyCi, type Check, type CheckOutcome } from "../../src/domain/Checks.ts"
import type { Ci } from "../../src/domain/Snapshot.ts"

const outcomes = gs.sampledFrom<CheckOutcome>(["passed", "pending", "failed", "ignored"])

interface Keyed {
  readonly check: Check
  readonly key: number
}

interface Newest {
  readonly identity: string
  readonly major: number
  readonly minor: number
}

interface Scenario {
  readonly checks: readonly Check[]
  readonly latest: readonly CheckOutcome[]
  readonly newest: readonly Newest[]
}

/** A generation strictly before `[major, minor]`, differing in either position. */
function olderThan(major: number, minor: number): gs.Generator<number[]> {
  return gs.composite((tc) =>
    tc.draw(gs.booleans()) && major > 0
      ? [tc.draw(gs.integers({ maxValue: major - 1, minValue: 0 })), tc.draw(gs.integers())]
      : [major, tc.draw(gs.integers({ maxValue: minor - 1 }))],
  )
}

/** One check identity: its newest runs (possibly tied) plus any superseded runs. */
function identityRuns(
  identity: string,
  newestOutcomes: Readonly<gs.Generator<CheckOutcome>>,
): gs.Generator<Scenario> {
  return gs.composite((tc) => {
    const major = tc.draw(gs.integers({ minValue: 0 }))
    const minor = tc.draw(gs.integers({ minValue: -1_000_000 }))
    const latest = tc.draw(gs.arrays(newestOutcomes, { minSize: 1 }))
    const older = tc.draw(gs.arrays(gs.tuples(olderThan(major, minor), outcomes)))
    const newest = latest.map((outcome) => ({ generation: [major, minor], identity, outcome }))

    const superseded = older.map(
      ([generation, outcome]: readonly [readonly number[], CheckOutcome]) => ({
        generation,
        identity,
        outcome,
      }),
    )

    return { checks: [...newest, ...superseded], latest, newest: [{ identity, major, minor }] }
  })
}

/** Checks for several identities, shuffled. Newest runs draw from `newestOutcomes`. */
const scenariosWith = (
  newestOutcomes: Readonly<gs.Generator<CheckOutcome>>,
  minIdentities = 0,
): gs.Generator<Scenario> =>
  gs.composite((tc) => {
    const identities = tc.draw(gs.sets(gs.text({ minSize: 1 }), { minSize: minIdentities }))
    const runs = [...identities].map((identity) => tc.draw(identityRuns(identity, newestOutcomes)))
    const checks = runs.flatMap((run) => run.checks)

    const order = tc.draw(
      gs.arrays(gs.integers(), { maxSize: checks.length, minSize: checks.length }),
    )

    const shuffled = checks
      .map((check: Check, index: number): Keyed => ({ check, key: order[index] ?? 0 }))
      .toSorted((left: Keyed, right: Keyed) => left.key - right.key)
      .map((entry: Keyed) => entry.check)

    return {
      checks: shuffled,
      latest: runs.flatMap((entry) => entry.latest),
      newest: runs.flatMap((entry) => entry.newest),
    }
  })

const scenarios = scenariosWith(outcomes)

function expectedCi(latest: readonly CheckOutcome[]): Ci {
  if (latest.includes("failed")) return "failed"

  if (latest.includes("pending")) return "pending"

  if (latest.includes("passed")) return "passed"

  return "none"
}

const run = (identity: string, generation: readonly number[], outcome: CheckOutcome): Check => ({
  generation,
  identity,
  outcome,
})

describe("classifyCi properties", () => {
  test("classifies by the newest runs of each check, in any order", () => {
    hegel.test((tc) => {
      const scenario = tc.draw(scenarios)

      tc.note(JSON.stringify(scenario))

      expect(classifyCi(scenario.checks)).toBe(expectedCi(scenario.latest))
    })
  })

  test("adding a superseded run never changes the result", () => {
    hegel.test((tc) => {
      const scenario = tc.draw(scenariosWith(outcomes, 1))
      const target = tc.draw(gs.sampledFrom(scenario.newest))
      const older = tc.draw(olderThan(target.major, target.minor))
      const superseded = run(target.identity, older, tc.draw(outcomes))

      expect(classifyCi([...scenario.checks, superseded])).toBe(classifyCi(scenario.checks))
    })
  })
})

describe("classifyCi examples", () => {
  test("ignores a cancelled run once a rerun passes", () => {
    const checks = [run("ci/test", [7, 1], "failed"), run("ci/test", [7, 2], "passed")]

    expect(classifyCi(checks)).toBe("passed")
  })

  test("reports a rerun in progress as pending even after an earlier failure", () => {
    const checks = [run("ci/test", [7, 1], "failed"), run("ci/test", [8, 1], "pending")]

    expect(classifyCi(checks)).toBe("pending")
  })

  // Reruns share a run number, so the attempt number decides which is current.
  test("ignores an earlier attempt of the same run", () => {
    const checks = [run("ci/test", [7, 2], "passed"), run("ci/test", [7, 1], "pending")]

    expect(classifyCi(checks)).toBe("passed")
  })

  test("counts every run tied for newest", () => {
    const checks = [run("ci/test", [7, 1], "passed"), run("ci/test", [7, 1], "failed")]

    expect(classifyCi(checks)).toBe("failed")
  })

  test("reports no checks when there are none, or only skipped ones", () => {
    expect(classifyCi([])).toBe("none")
    expect(classifyCi([run("ci/docs", [1], "ignored")])).toBe("none")
  })
})
