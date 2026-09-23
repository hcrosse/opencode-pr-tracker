import type { ResolvedTheme } from "@opencode/theme/tui"
import type { RGBA } from "@opentui/core"

import type { Tone } from "../domain/Appearance.ts"

/** The colors the sidebar uses, taken from the host theme. */
export interface Palette {
  readonly text: RGBA
  readonly muted: RGBA
  readonly tones: Readonly<Record<Tone, RGBA>>
}

/** Themes have no named purple; the accent hue is the closest, and is purple in the default theme. */
export function paletteOf(theme: ResolvedTheme): Palette {
  return {
    muted: theme.text.muted,
    text: theme.text.base,
    tones: {
      gray: theme.text.muted,
      green: theme.text.feedback.success.base,
      purple: theme.hue.accent[500],
      red: theme.text.feedback.error.base,
      yellow: theme.text.feedback.warning.base,
    },
  }
}
