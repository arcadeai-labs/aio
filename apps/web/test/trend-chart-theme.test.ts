import { describe, expect, test } from "bun:test";
import { REACH_LINE } from "../src/lib/cited-view";
import {
  BRAND_SOV,
  RANK_COLOR,
  SOV_HIGHLIGHT_COUNT,
  SOV_PALETTE,
} from "../src/lib/competitive-view";
import {
  CHART_SURFACE,
  DIM_STROKE_WIDTH,
  MIN_SERIES_CONTRAST,
  MIN_SERIES_SEPARATION,
  SERIES_STROKE_WIDTH,
  colorSeparation,
  contrastRatio,
  hasDrawableSeries,
  isDrawable,
} from "../src/lib/trend-chart-theme";

// Issue #25: all three TrendChart instances rendered as apparently empty panels
// at a 1431px viewport, and two independent verification agents nearly filed them
// as blank. The geometry was right the whole time — the strokes just did not
// register. These tests hold the floor, so the next palette edit cannot quietly
// put a 5.6:1 hairline back on screen and pass review on a green suite.

/** Every colour a TrendChart can draw as a highlighted series. */
const DRAWN_COLORS: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(RANK_COLOR).map(([k, v]) => [`RANK_COLOR.${k}`, v]),
  ),
  ...Object.fromEntries(SOV_PALETTE.map((c, i) => [`SOV_PALETTE[${i}]`, c])),
  BRAND_SOV,
  REACH_LINE,
};

const pairs = <T>(xs: readonly T[]): [T, T][] =>
  xs.flatMap((a, i) => xs.slice(i + 1).map((b): [T, T] => [a, b]));

describe("contrastRatio", () => {
  test("spans the WCAG range", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#4f8cc9", "#4f8cc9")).toBeCloseTo(1, 5);
  });

  test("is symmetric", () => {
    expect(contrastRatio("#74b0f0", CHART_SURFACE)).toBeCloseTo(
      contrastRatio(CHART_SURFACE, "#74b0f0"),
      5,
    );
  });
});

describe("every drawn series colour is legible on the chart surface", () => {
  for (const [name, hex] of Object.entries(DRAWN_COLORS)) {
    test(`${name} (${hex}) clears ${MIN_SERIES_CONTRAST}:1`, () => {
      expect(contrastRatio(hex, CHART_SURFACE)).toBeGreaterThanOrEqual(
        MIN_SERIES_CONTRAST,
      );
    });
  }

  test("the owned-citation line is no longer the weakest thing drawn", () => {
    // The single unoccluded line on /cited was the most-reported "empty" chart.
    // It used to be #4f8cc9 at 5.62:1 — the lowest of any drawn series.
    expect(contrastRatio("#4f8cc9", CHART_SURFACE)).toBeLessThan(
      MIN_SERIES_CONTRAST,
    );
    expect(contrastRatio(REACH_LINE, CHART_SURFACE)).toBeGreaterThan(
      contrastRatio("#4f8cc9", CHART_SURFACE),
    );
  });
});

describe("overlapping series stay individually traceable", () => {
  // /competitive share-of-voice draws the brand plus its competitors at once —
  // the hardest case, and the one the issue calls out.
  test("the seven drawn on /competitive are mutually distinguishable", () => {
    const seven = [BRAND_SOV, ...SOV_PALETTE.slice(0, 6)];
    expect(seven).toHaveLength(7);
    for (const [a, b] of pairs(seven)) {
      expect(colorSeparation(a, b)).toBeGreaterThanOrEqual(
        MIN_SERIES_SEPARATION,
      );
    }
  });

  test("the whole highlight budget stays distinguishable, not just the six the seed corpus happens to draw", () => {
    const all = [BRAND_SOV, ...SOV_PALETTE.slice(0, SOV_HIGHLIGHT_COUNT)];
    for (const [a, b] of pairs(all)) {
      expect(colorSeparation(a, b)).toBeGreaterThanOrEqual(
        MIN_SERIES_SEPARATION,
      );
    }
  });

  test("the four rank buckets are mutually distinguishable", () => {
    for (const [a, b] of pairs(Object.values(RANK_COLOR))) {
      expect(colorSeparation(a, b)).toBeGreaterThanOrEqual(
        MIN_SERIES_SEPARATION,
      );
    }
  });
});

describe("the dimmed context field stays recessive but visible", () => {
  const DIM_LINE = "#3a3f47"; // mirrors TrendChart.tsx

  test("reads as present", () => {
    expect(contrastRatio(DIM_LINE, CHART_SURFACE)).toBeGreaterThan(1.5);
  });

  test("never competes with a highlighted series", () => {
    expect(contrastRatio(DIM_LINE, CHART_SURFACE)).toBeLessThan(
      MIN_SERIES_CONTRAST,
    );
    expect(DIM_STROKE_WIDTH).toBeLessThan(SERIES_STROKE_WIDTH);
  });
});

describe("an empty chart is distinguishable from a populated one", () => {
  test("a series with any value is drawable", () => {
    expect(isDrawable([null, 0.2, null])).toBe(true);
  });

  test("a zero is data, not absence", () => {
    // The project's characteristic bug is a plausible number. A genuine 0%
    // must draw a line on the axis, not vanish into the empty state.
    expect(isDrawable([0, 0, 0])).toBe(true);
    expect(hasDrawableSeries([{ values: [0, 0, 0] }])).toBe(true);
  });

  test("an all-gap series is not drawable", () => {
    expect(isDrawable([null, null])).toBe(false);
  });

  test("no series at all is empty", () => {
    expect(hasDrawableSeries([])).toBe(false);
  });

  test("series that are all gaps are empty", () => {
    expect(
      hasDrawableSeries([{ values: [null, null] }, { values: [null] }]),
    ).toBe(false);
  });

  test("one populated series among gaps is not empty", () => {
    expect(
      hasDrawableSeries([{ values: [null, null] }, { values: [null, 0.5] }]),
    ).toBe(true);
  });
});
