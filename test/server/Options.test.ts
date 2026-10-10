import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { Array as Arr, Effect } from "effect"
import { describe, expect, test } from "vitest"

import {
  InvalidOptions,
  OptionProblem,
  settingsOf,
  type PluginSettings,
} from "../../src/server/Options.ts"

type Value = string | number | boolean | null

type Options = Readonly<Record<string, Value>>

const failureOf = (options: Options): InvalidOptions =>
  Effect.runSync(Effect.flip(settingsOf(options)))

const valid: readonly (readonly [string, Options, PluginSettings])[] = [
  ["no options", {}, { layout: "compact", reviews: "off" }],
  ["review state on", { reviews: "all" }, { layout: "compact", reviews: "all" }],
  ["the full layout", { layout: "full" }, { layout: "full", reviews: "off" }],
  ["both defaults", { layout: "compact", reviews: "off" }, { layout: "compact", reviews: "off" }],
  ["both options", { layout: "full", reviews: "all" }, { layout: "full", reviews: "all" }],
]

const wideLayout = 'Invalid value "wide" for option "layout". Allowed values: "full", "compact".'

const reviewChoices = 'Allowed values: "off", "all".'

const unknownTheme = 'Unknown option "theme". Known options: "layout", "reviews".'

const invalid: readonly (readonly [string, Options, string])[] = [
  ["an unknown layout", { layout: "wide", reviews: "all" }, wideLayout],
  [
    "an unknown review mode",
    { layout: "full", reviews: "some" },
    `Invalid value "some" for option "reviews". ${reviewChoices}`,
  ],
  [
    "a review mode of the wrong case",
    { reviews: "ALL" },
    `Invalid value "ALL" for option "reviews". ${reviewChoices}`,
  ],
  [
    "a layout that is not a string",
    { layout: true },
    'Invalid value true for option "layout". Allowed values: "full", "compact".',
  ],
  [
    "a null review mode",
    { reviews: null },
    `Invalid value null for option "reviews". ${reviewChoices}`,
  ],
  [
    "both options at once",
    { layout: "wide", reviews: "ALL" },
    `${wideLayout} Invalid value "ALL" for option "reviews". ${reviewChoices}`,
  ],
  ["an unknown option", { theme: "dark" }, unknownTheme],
  [
    "an unknown option whose name needs escaping",
    { 'line\nbreak"': "dark" },
    'Unknown option "line\\nbreak\\"". Known options: "layout", "reviews".',
  ],
  ["an unknown option beside a valid one", { layout: "full", theme: "dark" }, unknownTheme],
  [
    "an unknown option beside an invalid one",
    { layout: "wide", theme: "dark" },
    `${wideLayout} ${unknownTheme}`,
  ],
]

const values = gs.oneOf<Value>(
  gs.sampledFrom(["full", "compact", "default", "off", "all", "", "ALL"]),
  gs.integers(),
  gs.booleans(),
  gs.just(null),
)

/** An option drawn as absent, or present with a drawn value. */
const drawOption = (tc: hegel.TestCase, name: string): readonly (readonly [string, Value])[] =>
  tc.draw(gs.booleans()) ? [[name, tc.draw(values)]] : []

const choices = [
  ["layout", ["full", "compact"]],
  ["reviews", ["off", "all"]],
] as const

/** The problems drawn options should report: invalid values in reading order, then unknown keys. */
const problemsOf = (options: Options): readonly OptionProblem[] => {
  const invalidValues = choices.flatMap(([option, allowed]) =>
    Object.hasOwn(options, option) && !allowed.some((choice) => choice === options[option])
      ? [OptionProblem.cases.InvalidValue.make({ allowed, option, value: options[option] })]
      : [],
  )

  const unknownKeys = Object.keys(options).flatMap((option) =>
    option === "layout" || option === "reviews"
      ? []
      : [OptionProblem.cases.UnknownOption.make({ known: ["layout", "reviews"], option })],
  )

  return [...invalidValues, ...unknownKeys]
}

/** Drawn options succeed exactly when every key is known with an allowed value or absent. */
const checkDrawnOptions = (tc: hegel.TestCase): void => {
  const extra = tc.draw(gs.sampledFrom(["theme", "Layout", "review"]))

  const options: Options = Object.fromEntries([
    ...drawOption(tc, "layout"),
    ...drawOption(tc, "reviews"),
    ...drawOption(tc, extra),
  ])

  const problems = problemsOf(options)

  if (!Arr.isReadonlyArrayNonEmpty(problems)) {
    expect(Effect.runSync(settingsOf(options))).toStrictEqual({
      layout: options["layout"] === "full" ? "full" : "compact",
      reviews: options["reviews"] === "all" ? "all" : "off",
    })

    return
  }

  expect(failureOf(options).problems).toStrictEqual(problems)
}

describe("plugin options", () => {
  test.each(valid)("reads %s", (_name, options, settings) => {
    expect(Effect.runSync(settingsOf(options))).toEqual(settings)
  })

  test.each(invalid)("rejects %s, naming each problem", (_name, options, message) => {
    const error = failureOf(options)

    expect(error).toBeInstanceOf(InvalidOptions)
    expect(error.message).toBe(message)
  })

  test("accepts exactly known options with allowed values, and names every problem", () => {
    hegel.test(checkDrawnOptions)
  })
})
