import { describe, expect, test } from "bun:test"

import { Effect, Logger, Schema } from "effect"

import {
  loggedPerField,
  Unrecognized,
  UnrecognizedLog,
} from "../../../src/adapters/github/Enumeration.ts"

const Line = Schema.fromJsonString(
  Schema.Struct({
    annotations: Schema.Record(Schema.String, Schema.Unknown),
    level: Schema.String,
  }),
)

type Line = typeof Line.Type

/** Runs `effect`, returning the lines Effect's JSON logger wrote. */
function logged(effect: Effect.Effect<void>): readonly Line[] {
  const lines: string[] = []

  const capture = Logger.map(Logger.formatJson, (line: string) => {
    lines.push(line)
  })

  Effect.runSync(effect.pipe(Effect.provide(Logger.layer([capture]))))

  return lines.map((line: string) => Schema.decodeUnknownSync(Line)(line))
}

const status = (value: string): Unrecognized =>
  new Unrecognized({ field: "CheckRun.status", value })

const url = "https://github.com/acme/api/pull/1"

describe("unrecognized value logs", () => {
  test("count a value as logged only once its report runs", () => {
    const log = new UnrecognizedLog()

    // A report that never runs logs nothing and must not hide the value from a later one.
    log.report(url, [status("PAUSED")])

    expect(logged(log.report(url, [status("PAUSED")]))).toHaveLength(1)
    expect(logged(log.report(url, [status("PAUSED")]))).toHaveLength(0)
  })

  test("log a field's first values, then say once that the rest are not logged", () => {
    const log = new UnrecognizedLog()

    const values = Array.from({ length: loggedPerField + 5 }, (_, index: number) =>
      status(`S${String(index)}`),
    )

    const lines = logged(log.report(url, values))

    expect(lines.map((line: Line) => line.annotations["value"] ?? "limit")).toEqual([
      ...values.slice(0, loggedPerField).map((found: Unrecognized) => found.value),
      "limit",
    ])

    expect(logged(log.report(url, [status("ANOTHER")]))).toHaveLength(0)
    expect(
      logged(log.report(url, [new Unrecognized({ field: "Other.field", value: "X" })])),
    ).toHaveLength(1)
  })
})
