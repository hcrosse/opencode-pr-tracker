import { Array as Arr, Option, Order } from "effect"

export type Ci = "passed" | "pending" | "failed" | "none"

export type CheckOutcome = "passed" | "pending" | "failed" | "ignored"

/**
 * One check run or status context. Checks with the same `identity` are runs of one check;
 * only those with the greatest `generation` count. A generation is compared element by element,
 * for example `[runNumber, runAttempt]` or `[createdAtSeconds, createdAtNanoseconds]`.
 */
export interface Check {
  readonly identity: string
  readonly generation: readonly number[]
  readonly outcome: CheckOutcome
}

const generationOrder = Arr.makeOrder(Order.Number)

interface Latest {
  readonly generation: readonly number[]
  readonly outcomes: readonly CheckOutcome[]
}

/** The newest runs of one check after seeing `check`: a newer run replaces them, a tie joins them. */
function withRun(current: Option.Option<Latest>, check: Check): Latest {
  const replacement: Latest = { generation: check.generation, outcomes: [check.outcome] }

  return Option.match(current, {
    onNone: () => replacement,
    onSome: (existing: Latest): Latest => {
      const comparison = generationOrder(check.generation, existing.generation)

      if (comparison > 0) return replacement

      if (comparison < 0) return existing

      return { generation: existing.generation, outcomes: [...existing.outcomes, check.outcome] }
    },
  })
}

function latestOutcomes(checks: readonly Check[]): Set<CheckOutcome> {
  const latest = new Map<string, Latest>()

  for (const check of checks) {
    latest.set(check.identity, withRun(Option.fromNullishOr(latest.get(check.identity)), check))
  }

  return new Set([...latest.values()].flatMap((entry: Latest) => entry.outcomes))
}

/** Failed beats pending beats passed. Superseded runs are ignored; so are skipped or neutral runs. */
export function classifyCi(checks: readonly Check[]): Ci {
  const outcomes = latestOutcomes(checks)

  if (outcomes.has("failed")) return "failed"

  if (outcomes.has("pending")) return "pending"

  if (outcomes.has("passed")) return "passed"

  return "none"
}
