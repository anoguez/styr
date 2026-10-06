import type { ITheme } from '@xterm/xterm'
import type { ThemeSettings } from '@core/types.js'

export interface SurfaceRamp {
  chrome: string
  surface: string
  panel: string
  card: string
  raised: string
  edge: string
  edgeStrong: string
  ink: string
  dim: string
  faint: string
}

interface Hsl {
  h: number
  s: number
  l: number
}

/**
 * Lightness of each surface, measured from the original hand-picked palette. Keeping these fixed is
 * what guarantees contrast: the base colour supplies hue and saturation, and only nudges lightness.
 */
const LADDER: Record<keyof SurfaceRamp, number> = {
  chrome: 5,
  surface: 7,
  panel: 10.5,
  card: 12.5,
  raised: 16,
  edge: 17,
  edgeStrong: 22,
  ink: 93,
  dim: 65,
  faint: 47
}

/**
 * The same ramp for a light base, where surfaces step from tinted grey up to white and text is
 * dark. Only used when the base itself is light, so dark themes (Harbour included) are untouched.
 */
const LIGHT_LADDER: Record<keyof SurfaceRamp, number> = {
  chrome: 91,
  surface: 95,
  panel: 97,
  card: 99,
  raised: 100,
  edge: 87,
  edgeStrong: 78,
  ink: 12,
  dim: 36,
  faint: 46
}

/** A base lighter than this is treated as a light theme. */
const LIGHT_BASE_LIGHTNESS = 55

export function isLightBase(base: string): boolean {
  return hexToHsl(base).l >= LIGHT_BASE_LIGHTNESS
}

const TEXT_KEYS = new Set<keyof SurfaceRamp>(['ink', 'dim', 'faint'])

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function hexToHsl(hex: string): Hsl {
  const value = hex.replace('#', '')
  const r = parseInt(value.slice(0, 2), 16) / 255
  const g = parseInt(value.slice(2, 4), 16) / 255
  const b = parseInt(value.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const delta = max - min
  if (delta === 0) return { h: 220, s: 0, l: l * 100 }
  const s = delta / (1 - Math.abs(2 * l - 1))
  const h =
    max === r
      ? ((g - b) / delta + (g < b ? 6 : 0)) * 60
      : max === g
        ? ((b - r) / delta + 2) * 60
        : ((r - g) / delta + 4) * 60
  return { h, s: s * 100, l: l * 100 }
}

export function hslToHex({ h, s, l }: Hsl): string {
  const sat = clamp(s, 0, 100) / 100
  const light = clamp(l, 0, 100) / 100
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x]
  const m = light - c / 2
  const channel = (v: number): string =>
    Math.round(clamp((v + m) * 255, 0, 255))
      .toString(16)
      .padStart(2, '0')
  return `#${channel(r1)}${channel(g1)}${channel(b1)}`
}

/**
 * Builds every surface and text colour from one base. The base's hue and saturation carry through;
 * its lightness only shifts the ladder, clamped so the interface can never wash out or lose
 * contrast whatever colour is picked.
 */
export function surfaceRamp(base: string): SurfaceRamp {
  const { h, s, l } = hexToHsl(base)
  const light = l >= LIGHT_BASE_LIGHTNESS
  const shift = clamp(l - LADDER.surface, -4, 8)
  const tone = (key: keyof SurfaceRamp): string => {
    const isText = TEXT_KEYS.has(key)
    if (light) {
      return hslToHex({
        h,
        s: isText ? clamp(s, 0, 20) : clamp(s, 0, 30),
        l: LIGHT_LADDER[key]
      })
    }
    return hslToHex({
      h,
      s: isText ? clamp(s, 0, 16) : clamp(s, 0, 45),
      l: isText ? LADDER[key] : clamp(LADDER[key] + shift, 3, 30)
    })
  }

  return {
    chrome: tone('chrome'),
    surface: tone('surface'),
    panel: tone('panel'),
    card: tone('card'),
    raised: tone('raised'),
    edge: tone('edge'),
    edgeStrong: tone('edgeStrong'),
    ink: tone('ink'),
    dim: tone('dim'),
    faint: tone('faint')
  }
}

/** A base hex as an rgba() string, for tinting a gradient without a second colour setting. */
export function rgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const channel = (i: number): number => parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${alpha})`
}

/**
 * A soft wash over the app background: a hint of the accent in the top corner over a gentle
 * vertical shift of the base. Kept low-contrast so text and cards stay readable on top of it.
 */
export function backgroundGradient(
  base: string,
  accent: string,
  strength: number,
  angle: number
): string {
  const { h, s, l } = hexToHsl(base)
  const amount = clamp(strength, 0, 1)
  if (l >= LIGHT_BASE_LIGHTNESS) {
    const top = hslToHex({ h, s, l: Math.min(l + 3 * amount, 99) })
    const bottom = hslToHex({ h, s, l: Math.max(l - 5 * amount, 80) })
    return (
      `radial-gradient(1200px 620px at 6% -16%, ${rgba(accent, 0.16 * amount)}, transparent 58%), ` +
      `radial-gradient(900px 500px at 100% 108%, ${rgba(accent, 0.08 * amount)}, transparent 60%), ` +
      `linear-gradient(${angle}deg, ${top} 0%, ${bottom} 68%)`
    )
  }
  const top = hslToHex({ h, s: Math.min(s + 8 * amount, 45), l: Math.min(l + 10 * amount, 34) })
  const bottom = hslToHex({ h, s, l: Math.max(l - 2.5 * amount, 2) })
  return (
    `radial-gradient(1200px 620px at 6% -16%, ${rgba(accent, 0.28 * amount)}, transparent 58%), ` +
    `radial-gradient(900px 500px at 100% 108%, ${rgba(accent, 0.13 * amount)}, transparent 60%), ` +
    `linear-gradient(${angle}deg, ${top} 0%, ${bottom} 68%)`
  )
}

function channelLuminance(value: number): number {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function luminance(hex: string): number {
  const value = hex.replace('#', '')
  const part = (i: number): number => parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return (
    0.2126 * channelLuminance(part(0)) +
    0.7152 * channelLuminance(part(1)) +
    0.0722 * channelLuminance(part(2))
  )
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Black or white, whichever is readable on the given fill. */
export function onColor(fill: string): string {
  return contrastRatio(fill, '#ffffff') >= contrastRatio(fill, '#111111') ? '#ffffff' : '#111111'
}

/**
 * Nudges a colour's lightness until it reads against a background. Used for accents and column
 * colours that are also drawn as text — a colour picked because it looks good as a fill is often
 * unreadable as a label.
 */
export function legibleOn(colour: string, background: string, minRatio = 4.5): string {
  if (contrastRatio(colour, background) >= minRatio) return colour
  const { h, s, l } = hexToHsl(colour)
  const goingLighter = luminance(background) < 0.2
  for (let step = 1; step <= 100; step += 1) {
    const next = hslToHex({ h, s, l: clamp(goingLighter ? l + step : l - step, 0, 100) })
    if (contrastRatio(next, background) >= minRatio) return next
  }
  return goingLighter ? '#ffffff' : '#111111'
}

/**
 * The xterm theme for a set of theme settings. The chrome — background, text, cursor, selection —
 * is derived from the same ramp as the rest of the app so the panel never sits off against the
 * window around it. The 16 ANSI slots are passed through as stored: they carry meaning a program
 * chose (red is an error, green is a pass) and deriving them would destroy it.
 */
export function terminalTheme(theme: ThemeSettings): ITheme {
  const ramp = surfaceRamp(theme.base)
  return {
    ...theme.terminalPalette,
    background: ramp.chrome,
    foreground: ramp.ink,
    cursor: theme.accent,
    cursorAccent: ramp.chrome,
    selectionBackground: rgba(theme.accent, 0.3),
    selectionForeground: onColor(theme.accent)
  }
}
