/**
 * Colour encodings for every quantitative display in the app.
 *
 * The rules here are deliberate and worth not "improving" casually:
 *
 *  - Heatmaps use a **diverging blue↔red ramp with a neutral grey midpoint**,
 *    because what a manager actually reads off them is "am I above or below the
 *    league at this position". The original app used red→yellow→green, which is
 *    the textbook red/green confusion case — roughly 1 in 12 men cannot read it.
 *  - Value Score uses a **single-hue sequential ramp** (magnitude, not polarity).
 *    The original mapped it to a red→green hue rotation, another rainbow.
 *  - Boom/bust wears the **reserved status palette** and always ships an icon and
 *    a text label, so colour is never the only channel carrying the meaning.
 *  - Every heatmap cell also prints its number, so the colour is reinforcement
 *    rather than the sole encoding.
 *
 * All values are drawn from the validated palette; the two-series chart pair
 * (#2a78d6/#eb6834 light, #3987e5/#d95926 dark) passes lightness, chroma, CVD
 * separation, normal-vision separation and 3:1 surface contrast in both modes.
 */

import { clamp01 } from './stats';

/* -------------------------------------------------------------------------- */
/* OKLab conversion — used to interpolate ramps perceptually rather than in     */
/* sRGB, which is what keeps the diverging arms lightness-monotone.            */
/* -------------------------------------------------------------------------- */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const to = (v: number) => {
    const n = Math.round(clamp01(v) * 255);
    return n.toString(16).padStart(2, '0');
  };
  return `#${to(r)}${to(g)}${to(b)}`;
}

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

const linearToSrgb = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

interface Oklab {
  L: number;
  a: number;
  b: number;
}

function rgbToOklab(c: Rgb): Oklab {
  const r = srgbToLinear(c.r);
  const g = srgbToLinear(c.g);
  const b = srgbToLinear(c.b);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb(c: Oklab): Rgb {
  const l = (c.L + 0.3963377774 * c.a + 0.2158037573 * c.b) ** 3;
  const m = (c.L - 0.1055613458 * c.a - 0.0638541728 * c.b) ** 3;
  const s = (c.L - 0.0894841775 * c.a - 1.291485548 * c.b) ** 3;

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

/** Perceptually-uniform mix between two hex colours. `t` runs 0→1. */
export function mixOklab(fromHex: string, toHex: string, t: number): string {
  const a = rgbToOklab(hexToRgb(fromHex));
  const b = rgbToOklab(hexToRgb(toHex));
  const k = clamp01(t);
  return rgbToHex(
    oklabToRgb({
      L: a.L + (b.L - a.L) * k,
      a: a.a + (b.a - a.a) * k,
      b: a.b + (b.b - a.b) * k,
    }),
  );
}

/** Relative luminance, for choosing readable text on a generated fill. */
function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG contrast ratio between two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Picks whichever ink reads better on a generated background.
 * Needed because heatmap fills are computed, not hand-picked.
 */
export function inkFor(background: string, mode: Mode): string {
  const light = mode === 'dark' ? '#ffffff' : '#0b0b0b';
  const dark = mode === 'dark' ? '#0b0b0b' : '#ffffff';
  return contrastRatio(background, light) >= contrastRatio(background, dark) ? light : dark;
}

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

export type Mode = 'light' | 'dark';

/** Two-series categorical slots. Slot 1 = projected, slot 2 = actual. */
export const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a'],
  dark: ['#3987e5', '#d95926', '#199e70'],
} as const;

/** Single-hue sequential ramp (blue), light→dark. Used for magnitude. */
export const SEQUENTIAL_BLUE = [
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#184f95',
  '#104281',
  '#0d366b',
] as const;

/** Diverging poles and neutral midpoints, per mode. */
const DIVERGING = {
  light: { low: '#e34948', mid: '#f0efec', high: '#2a78d6' },
  dark: { low: '#e66767', mid: '#383835', high: '#3987e5' },
} as const;

/** Reserved status palette. Never themed, never reused for a series. */
export const STATUS_COLORS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

/* -------------------------------------------------------------------------- */
/* Encodings                                                                   */
/* -------------------------------------------------------------------------- */

export interface HeatCell {
  background: string;
  ink: string;
}

/**
 * Diverging heatmap fill.
 *
 * `t` is the value's position within the column, already normalised to 0..1
 * with 0.5 meaning "at the league midpoint". Callers should normalise around
 * the median rather than the min so the neutral midpoint is meaningful.
 *
 * `emphasis` lifts the selected team's own row so it stands out without
 * changing its hue.
 */
export function heatmapCell(t: number, mode: Mode, emphasis = false): HeatCell {
  const { low, mid, high } = DIVERGING[mode];
  const k = clamp01(t);

  // Each arm gets equal step count, meeting at the neutral midpoint.
  const background =
    k < 0.5 ? mixOklab(low, mid, k * 2) : mixOklab(mid, high, (k - 0.5) * 2);

  // Selected row is pushed one notch further from the surface for emphasis.
  const finalBg = emphasis
    ? mixOklab(background, mode === 'dark' ? '#ffffff' : '#0b0b0b', 0.12)
    : background;

  return { background: finalBg, ink: inkFor(finalBg, mode) };
}

/**
 * Normalises a value against a column of values, centred on the median.
 *
 * Centring on the median (rather than the midpoint of min/max) is what makes
 * the diverging encoding honest: the neutral colour genuinely means "typical",
 * even when one team has a runaway week.
 */
export function divergingPosition(value: number, column: number[]): number {
  if (column.length < 2) return 0.5;

  const sorted = [...column].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  if (value === mid || max === min) return 0.5;

  if (value < mid) {
    const span = mid - min;
    return span <= 0 ? 0.5 : 0.5 * clamp01((value - min) / span);
  }

  const span = max - mid;
  return span <= 0 ? 0.5 : 0.5 + 0.5 * clamp01((value - mid) / span);
}

/**
 * Sequential fill for a Value Score (0–1000).
 *
 * Rendered as a chip background with text in normal ink — the number itself is
 * never coloured, so it stays readable at every step of the ramp.
 */
export function valueScoreFill(score: number | null, mode: Mode): HeatCell {
  if (score === null || !Number.isFinite(score)) {
    return {
      background: mode === 'dark' ? '#2c2c2a' : '#e1e0d9',
      ink: mode === 'dark' ? '#c3c2b7' : '#52514e',
    };
  }

  // Real scores cluster between ~400 and ~850, so anchoring the ramp there uses
  // the full colour range instead of wasting it on empty tails.
  const t = clamp01((score - 420) / (850 - 420));
  const idx = Math.round(t * (SEQUENTIAL_BLUE.length - 1));
  const background = SEQUENTIAL_BLUE[idx];

  return { background, ink: inkFor(background, mode) };
}

/**
 * Sequential fill for a Matchup Score (0–100), where 100 is the softest
 * matchup. Same ramp as Value so the two read as the same kind of quantity.
 */
export function matchupScoreFill(score: number | null, mode: Mode): HeatCell {
  if (score === null || !Number.isFinite(score)) {
    return {
      background: mode === 'dark' ? '#2c2c2a' : '#e1e0d9',
      ink: mode === 'dark' ? '#c3c2b7' : '#52514e',
    };
  }

  const idx = Math.round(clamp01(score / 100) * (SEQUENTIAL_BLUE.length - 1));
  const background = SEQUENTIAL_BLUE[idx];
  return { background, ink: inkFor(background, mode) };
}
