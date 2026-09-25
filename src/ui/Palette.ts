import { RGBA } from "@opentui/core"

import type { Tone } from "../domain/Appearance.ts"

/** The colors the sidebar uses, taken from the host theme. */
export interface Palette {
  readonly text: RGBA
  readonly muted: RGBA
  readonly tones: Readonly<Record<Tone, RGBA>>
}

/** The host theme colors the palette reads. OpenCode's `ResolvedTheme` provides them. */
export interface ThemeColors {
  readonly text: {
    readonly base: RGBA
    readonly muted: RGBA
    readonly feedback: {
      readonly error: { readonly base: RGBA }
      readonly success: { readonly base: RGBA }
      readonly warning: { readonly base: RGBA }
    }
  }
}

interface Oklch {
  readonly l: number
  readonly c: number
  readonly h: number
}

interface Linear {
  readonly red: number
  readonly green: number
  readonly blue: number
}

const toLinear = (value: number): number =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4

const fromLinear = (value: number): number =>
  Math.min(1, Math.max(0, value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055))

function oklchOf(color: RGBA): Oklch {
  const [red, green, blue] = [toLinear(color.r), toLinear(color.g), toLinear(color.b)]

  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue)
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue)
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue)

  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s

  return {
    c: Math.hypot(a, b),
    h: Math.atan2(b, a),
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
  }
}

/** Linear sRGB channels, which fall outside [0, 1] when the color is out of gamut. */
function linearOf({ c, h, l }: Oklch): Linear {
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)

  const long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3

  return {
    blue: -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
    green: -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    red: 4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
  }
}

const inGamut = ({ blue, green, red }: Linear): boolean =>
  [red, green, blue].every((channel) => channel >= -1e-6 && channel <= 1 + 1e-6)

/** The color, with the largest chroma up to the requested one that fits sRGB. Gray always fits. */
function rgbaOf({ c, h, l }: Oklch): RGBA {
  let fits = 0
  let fails = c

  if (inGamut(linearOf({ c, h, l }))) fits = c

  for (let step = 0; step < 20 && fits < fails; step += 1) {
    const chroma = (fits + fails) / 2

    if (inGamut(linearOf({ c: chroma, h, l }))) fits = chroma
    else fails = chroma
  }

  const { blue, green, red } = linearOf({ c: fits, h, l })

  return RGBA.fromValues(fromLinear(red), fromLinear(green), fromLinear(blue))
}

/** The hue of GitHub's merged purple, `#8250df`. */
const mergedHue = oklchOf(RGBA.fromHex("#8250df")).h

/**
 * The color for merged pull requests. Themes have no dependable purple: the V1 `secondary` color
 * becomes muted text in V2, and the purple V2 infers can be another hue, such as Catppuccin's pink
 * accent. Merged keeps GitHub's hue with the lightness and chroma of the theme's error and success
 * colors, so it sits among the theme's other status colors.
 */
function mergedOf(theme: ThemeColors): RGBA {
  const error = oklchOf(theme.text.feedback.error.base)
  const success = oklchOf(theme.text.feedback.success.base)

  return rgbaOf({
    c: (error.c + success.c) / 2,
    h: mergedHue,
    l: (error.l + success.l) / 2,
  })
}

export function paletteOf(theme: ThemeColors): Palette {
  return {
    muted: theme.text.muted,
    text: theme.text.base,
    tones: {
      gray: theme.text.muted,
      green: theme.text.feedback.success.base,
      purple: mergedOf(theme),
      red: theme.text.feedback.error.base,
      yellow: theme.text.feedback.warning.base,
    },
  }
}
