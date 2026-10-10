import { Layer, Logger, Schema } from "effect"

const Line = Schema.fromJsonString(
  Schema.Struct({
    annotations: Schema.Record(Schema.String, Schema.Unknown),
    level: Schema.String,
    message: Schema.Unknown,
  }),
)

export type Logged = typeof Line.Type

export interface LogCapture {
  /** Replaces every logger with one that records each line. */
  readonly layer: Layer.Layer<never>
  readonly lines: () => readonly Logged[]
}

/** Records each log line as Effect's JSON logger writes it. */
export function captureLogs(): LogCapture {
  const lines: Logged[] = []

  const capture = Logger.map(Logger.formatJson, (line: string) => {
    lines.push(Schema.decodeUnknownSync(Line)(line))
  })

  return { layer: Logger.layer([capture]), lines: () => lines }
}
