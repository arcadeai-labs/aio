// The legibility rules for TrendChart, extracted from the component so the thing
// that decides whether a drawn line can actually be *seen* is testable without
// rendering a chart — the same split as trend-chart-view.ts, which covers whether
// a drawn line's value can be read.
//
// Why this file exists (issue #25): three TrendChart instances rendered as
// apparently empty panels at a 1431px viewport. Two independent verification
// agents nearly filed them as blank. The data was correct and the geometry was
// correct; 2px strokes in mid-tone colours on a near-black surface simply did not
// register. The numbers below are measured against CHART_SURFACE, and the test
// suite asserts every colour TrendChart can draw still clears the floor — so a
// future palette edit cannot quietly reintroduce a hairline nobody can see.
//
// DESIGN.md §9 asks for "thin lines, sparse grid". These strokes are still thin;
// the grid is untouched. The deviation from the literal word "thin" is recorded
// by the driver on issue #25.

/** The near-black app background every series is drawn against (`--bg`). */
export const CHART_SURFACE = "#08090a";

/** Stroke width for a highlighted series. */
export const SERIES_STROKE_WIDTH = 2.75;

/** Stroke width for the dimmed context field behind the highlighted series. */
export const DIM_STROKE_WIDTH = 1.5;

/**
 * The contrast floor every highlighted series colour must clear against
 * {@link CHART_SURFACE}. The old REACH_LINE measured 5.62:1 and was the single
 * most-reported "empty" chart, so the floor sits above it deliberately.
 */
export const MIN_SERIES_CONTRAST = 7;

/**
 * The perceptual separation (CIE76 ΔE) any two series drawn together must keep,
 * so the seven overlapping lines on `/competitive` share-of-voice stay
 * individually traceable. ~10 is "noticeable at a glance"; 20 is comfortable
 * across a crossover.
 */
export const MIN_SERIES_SEPARATION = 20;

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const at = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
  return [at(0), at(2), at(4)];
};

const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** WCAG relative-contrast ratio, 1:1 (identical) to 21:1 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB → CIE L*a*b* (D65), so colours can be compared the way an eye does
 * rather than by raw channel arithmetic. */
const lab = (hex: string): [number, number, number] => {
  const [r, g, b] = rgb(hex).map(channel) as [number, number, number];
  // Linear sRGB → XYZ (D65), then XYZ → Lab.
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) =>
    t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29;
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};

/** CIE76 ΔE between two colours. Coarse, but enough to catch two series that
 * would read as the same line where they cross. */
export function colorSeparation(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** A series carries a drawable line only if at least one run has a value. An
 * all-null series is a gap everywhere, not a flat zero. */
export function isDrawable(values: readonly (number | null)[]): boolean {
  return values.some((v) => v != null);
}

/**
 * Whether the chart has anything to draw at all.
 *
 * This is the guard behind the explicit empty state. On this project the
 * characteristic bug is a plausible-but-wrong reading, and "no data" rendering
 * as an identical blank panel to "data present but invisible" is exactly that
 * failure — so the two must be told apart by the component, not by the eye.
 */
export function hasDrawableSeries(
  series: readonly { values: readonly (number | null)[] }[],
): boolean {
  return series.some((s) => isDrawable(s.values));
}
