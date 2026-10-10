import type { Plugin } from "@opencode/plugin/effect"
import { Array as Arr, Effect, Result, Schema } from "effect"

import { ReviewMode } from "../domain/Review.ts"
import { Layout } from "../rpc.ts"

/** The plugin's settings from its options in OpenCode's configuration. */
export interface PluginSettings {
  readonly layout: Layout
  readonly reviews: ReviewMode
}

type Options = Plugin.Context["options"]

/** A problem with one key of the plugin's options in OpenCode's configuration. */
export const OptionProblem = Schema.TaggedUnion({
  InvalidValue: {
    allowed: Schema.Array(Schema.String),
    option: Schema.String,
    value: Schema.Unknown,
  },
  UnknownOption: {
    known: Schema.Array(Schema.String),
    option: Schema.String,
  },
})

export type OptionProblem = typeof OptionProblem.Type

const quoted = (values: readonly string[]): string =>
  values.map((value) => JSON.stringify(value)).join(", ")

const describe = OptionProblem.match({
  InvalidValue: (problem) =>
    `Invalid value ${JSON.stringify(problem.value)} for option "${problem.option}". Allowed values: ${quoted(problem.allowed)}.`,
  UnknownOption: (problem) =>
    `Unknown option ${JSON.stringify(problem.option)}. Known options: ${quoted(problem.known)}.`,
})

/** Every problem with the plugin's options in OpenCode's configuration, in reading order. */
export class InvalidOptions extends Schema.TaggedError<InvalidOptions>()("InvalidOptions", {
  problems: Schema.NonEmptyArray(OptionProblem),
}) {
  public override get message(): string {
    return this.problems.map((problem) => describe(problem)).join(" ")
  }
}

/** Reads the option `key`: `fallback` when absent, or a problem when the value is not in `allowed`. */
const optionOf = <const L extends readonly string[]>(
  key: string,
  allowed: L,
  fallback: L[number],
): ((options: Options) => Result.Result<L[number], OptionProblem>) => {
  const decode = Schema.decodeUnknownResult(Schema.Literals(allowed))

  return (options) => {
    if (!Object.hasOwn(options, key)) return Result.succeed(fallback)

    const value: unknown = options[key]

    return Result.mapError(decode(value), () =>
      OptionProblem.cases.InvalidValue.make({ allowed, option: key, value }),
    )
  }
}

const layoutOf = optionOf("layout", Layout.literals, "compact")

const reviewsOf = optionOf("reviews", ReviewMode.literals, "off")

const known = ["layout", "reviews"]

/**
 * An absent option takes its default: the "compact" layout and review state "off". Unknown keys and
 * values the options do not allow fail together, naming each one.
 */
export const settingsOf = Effect.fn("Options.settingsOf")(function* (options: Options) {
  const layout = layoutOf(options)
  const reviews = reviewsOf(options)

  const unknown = Object.keys(options).flatMap((option) =>
    known.includes(option) ? [] : [OptionProblem.cases.UnknownOption.make({ known, option })],
  )

  const problems = [...Arr.getFailures([layout, reviews]), ...unknown]

  if (Arr.isArrayNonEmpty(problems)) return yield* new InvalidOptions({ problems })

  const settings: PluginSettings = {
    layout: Result.getOrElse(layout, () => "compact" as const),
    reviews: Result.getOrElse(reviews, () => "off" as const),
  }

  return settings
})
