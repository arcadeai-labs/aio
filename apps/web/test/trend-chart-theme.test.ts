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
  reservedSignalHue,
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

describe("green and red stay reserved for signal (DESIGN.md §9)", () => {
  // Round 1 of review caught SOV_PALETTE[0] = #4ade80 (the literal rank-1 green)
  // and SOV_PALETTE[9] = #f87171 on ordinary competitor lines. The suite passed
  // 30/30 at the time: it held contrast and separation and said nothing about
  // *meaning*, so a test could not fail on the thing that broke. This block is
  // that missing assertion. A competitor drawn in green reads as "good", and on
  // share of voice the competitor climbing is the bad news — the colour inverts
  // the signal, which is worse than an ugly palette.

  // A classifier that never fires would make every test below pass while
  // protecting nothing, so pin the positives first.
  test("fires on the colours the rule exists to protect", () => {
    expect(reservedSignalHue(RANK_COLOR["1"])).toBe("green");
    expect(reservedSignalHue(RANK_COLOR.not_ranked)).toBe("red");
    // The two values review caught, and the Tailwind 500s a contributor
    // reaching for "a green"/"a red" would most likely paste.
    expect(reservedSignalHue("#4ade80")).toBe("green");
    expect(reservedSignalHue("#f87171")).toBe("red");
    expect(reservedSignalHue("#22c55e")).toBe("green");
    expect(reservedSignalHue("#ef4444")).toBe("red");
    expect(reservedSignalHue("#16a34a")).toBe("green");
    expect(reservedSignalHue("#dc2626")).toBe("red");
  });

  test("does not fire on neighbouring hues that read as their own colour", () => {
    // The bands have to leave a categorical palette somewhere to stand.
    expect(reservedSignalHue("#2dd4bf")).toBeNull(); // teal, 173°
    expect(reservedSignalHue("#38bdf8")).toBeNull(); // sky, 198°
    expect(reservedSignalHue("#f472b6")).toBeNull(); // rose, 329°
    expect(reservedSignalHue("#fb923c")).toBeNull(); // orange, 27°
    expect(reservedSignalHue("#fbbf24")).toBeNull(); // amber, 43°
  });

  test("does not fire on a near-neutral sitting at a reserved hue angle", () => {
    // A grey is not signal, whatever its hue angle computes to.
    expect(reservedSignalHue(BRAND_SOV)).toBeNull();
    expect(reservedSignalHue("#4a4442")).toBeNull(); // 8°, saturation 0.05
  });

  for (const [i, hex] of SOV_PALETTE.entries()) {
    test(`SOV_PALETTE[${i}] (${hex}) is not a reserved signal colour`, () => {
      // competitive.tsx assigns these round-robin to *every* competitor series.
      expect(reservedSignalHue(hex)).toBeNull();
    });
  }

  test("the single /cited line is not a reserved signal colour either", () => {
    expect(reservedSignalHue(REACH_LINE)).toBeNull();
  });

  test("RANK_COLOR is the sanctioned use and keeps its green and red", () => {
    // The rule is "reserved *for* good/bad signal", not "never used". The rank
    // ramp is exactly that signal, and it is out of scope for issue #25 — this
    // asserts the fix did not overshoot into it.
    expect(RANK_COLOR["1"]).toBe("#4ade80");
    expect(RANK_COLOR.not_ranked).toBe("#ff8585");
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
