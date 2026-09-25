import { describe, expect, test } from "bun:test"

import * as hegel from "@hegeldev/hegel"
import * as gs from "@hegeldev/hegel/generators"
import { RGBA } from "@opentui/core"

import { paletteOf, type ThemeColors } from "../../src/ui/Palette.ts"

const themeOf = (error: RGBA, success: RGBA): ThemeColors => ({
  text: {
    base: RGBA.fromHex("#ffffff"),
    feedback: {
      error: { base: error },
      success: { base: success },
      warning: { base: RGBA.fromHex("#ffff00") },
    },
    muted: RGBA.fromHex("#808080"),
  },
})

const merged = (error: string, success: string): RGBA =>
  paletteOf(themeOf(RGBA.fromHex(error), RGBA.fromHex(success))).tones.purple

/** The largest channel difference between two colors, in 0 to 255 steps. */
function distance(left: RGBA, right: RGBA): number {
  const [leftRed, leftGreen, leftBlue] = left.toInts()
  const [rightRed, rightGreen, rightBlue] = right.toInts()

  return Math.max(
    Math.abs(leftRed - rightRed),
    Math.abs(leftGreen - rightGreen),
    Math.abs(leftBlue - rightBlue),
  )
}

const brightness = (color: RGBA): number => color.r + color.g + color.b

const channel = gs.integers({ maxValue: 255, minValue: 0 })

const saturated = gs
  .tuples(channel, channel, channel)
  .filter((rgb: readonly number[]) => Math.max(...rgb) - Math.min(...rgb) >= 64)
  .map(([red, green, blue]: readonly number[]) => RGBA.fromInts(red ?? 0, green ?? 0, blue ?? 0))

describe("merged pull request color", () => {
  test("lands near each theme's own purple", () => {
    // Error, success, and the theme's purple, from OpenCode's built-in themes.
    const themes = [
      ["catppuccin dark", "#f38ba8", "#a6e3a1", "#cba6f7"],
      ["dracula", "#ff5555", "#50fa7b", "#bd93f9"],
      ["tokyonight dark", "#ff757f", "#c3e88d", "#c099ff"],
      ["opencode light", "#d1383d", "#3d9a57", "#7b5bb6"],
    ] as const

    const far = themes.filter(
      ([, error, success, purple]) => distance(merged(error, success), RGBA.fromHex(purple)) > 32,
    )

    expect(far.map(([name]) => name)).toEqual([])
  })

  test("is darker in a light theme than in a dark one", () => {
    expect(brightness(merged("#cf222e", "#1a7f37"))).toBeLessThan(
      brightness(merged("#f85149", "#3fb950")),
    )
  })

  test("stays a purple for any saturated status colors", () => {
    hegel.test((tc) => {
      const [red, green, blue] = paletteOf(
        themeOf(tc.draw(saturated), tc.draw(saturated)),
      ).tones.purple.toInts()

      expect(blue).toBeGreaterThanOrEqual(red)
      expect(red).toBeGreaterThan(green)
    })
  })
})
