import type { ResolvedTheme } from "@opencode/theme/tui"
import { RGBA } from "@opentui/core"

import type { Tone } from "../domain/Appearance.ts"

/** The colors the sidebar uses, taken from the host theme. */
export interface Palette {
  readonly text: RGBA
  readonly muted: RGBA
  readonly tones: Readonly<Record<Tone, RGBA>>
}

/**
 * GitHub's color for merged pull requests. Themes have no purple of their own, and a theme's accent
 * can be any hue, so merged uses GitHub's purple for the theme's mode.
 */
const merged: Readonly<Record<"dark" | "light", RGBA>> = {
  dark: RGBA.fromHex("#8957e5"),
  light: RGBA.fromHex("#8251de"),
}

export function paletteOf(theme: ResolvedTheme, mode: "dark" | "light"): Palette {
  return {
    muted: theme.text.muted,
    text: theme.text.base,
    tones: {
      gray: theme.text.muted,
      green: theme.text.feedback.success.base,
      purple: merged[mode],
      red: theme.text.feedback.error.base,
      yellow: theme.text.feedback.warning.base,
    },
  }
}
