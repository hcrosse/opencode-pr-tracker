import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"

import { settingsOf, type PluginSettings } from "../../src/server/Options.ts"

describe("plugin options", () => {
  test.each<readonly [string, Readonly<Record<string, string>>, PluginSettings]>([
    ["no options", {}, { layout: "compact", reviews: "off" }],
    ["review state on", { reviews: "all" }, { layout: "compact", reviews: "all" }],
    ["both options", { layout: "full", reviews: "all" }, { layout: "full", reviews: "all" }],
    [
      "an unknown review mode",
      { layout: "full", reviews: "some" },
      { layout: "full", reviews: "off" },
    ],
    [
      "an unknown layout",
      { layout: "wide", reviews: "all" },
      { layout: "compact", reviews: "all" },
    ],
  ])("reads %s", (_name, options, settings) => {
    expect(settingsOf(options)).toEqual(settings)
  })

  test("an invalid option never resets a valid one", () => {
    const values = gs.oneOf<string | number | boolean | null>(
      gs.sampledFrom(["full", "compact", "default", "off", "all", "", "ALL"]),
      gs.integers(),
      gs.booleans(),
      gs.just(null),
    )

    hegel.test((tc) => {
      const layout = tc.draw(values)
      const reviews = tc.draw(values)
      const both = settingsOf({ layout, reviews })

      expect(both.layout).toBe(settingsOf({ layout }).layout)
      expect(both.reviews).toBe(settingsOf({ reviews }).reviews)
      expect(both.layout).toBe(layout === "full" ? "full" : "compact")
      expect(both.reviews).toBe(reviews === "all" ? "all" : "off")
    })
  })
})
