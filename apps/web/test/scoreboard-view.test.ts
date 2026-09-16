import { describe, expect, test } from "bun:test";
import type { Delta } from "@aio/db";
import {
  HEADLINE_DELTA,
  TABLE_DELTA,
  count,
  deltaClass,
  deltaCount,
  deltaPts,
  deltaPtsLabeled,
  deltaScore,
  neutralDeltaClass,
  newDeltaClass,
  pct,
  score,
} from "../src/lib/scoreboard-view";

// The delta formatters are the shared boundary between the pooled headline and
// the three scoreboard tables (issue #40 / #28), so they're tested once here
// rather than re-derived per view.

const d = (absolute: number | null): Delta => ({
  absolute,
  direction:
    absolute === null
      ? null
      : absolute > 0
        ? "up"
        : absolute < 0
          ? "down"
          : "flat",
});

describe("value formatters", () => {
  test("rates render as a 1 dp percentage; a null cohort renders an em dash", () => {
    expect(pct(0.4567)).toBe("45.7%");
    expect(pct(0)).toBe("0.0%");
    expect(pct(null)).toBe("—");
  });

  test("accuracy renders as a 2 dp score, never a percentage", () => {
    expect(score(4.235)).toBe("4.24");
    expect(score(null)).toBe("—");
  });

  test("counts use a pinned locale (SSR and client must agree)", () => {
    expect(count(3198)).toBe("3,198");
  });
});

describe("deltaPts — rate deltas in percentage points", () => {
  test("signed to 1 dp, with an explicit sign for every direction", () => {
    expect(deltaPts(d(0.018))).toBe("+1.8");
    expect(deltaPts(d(-0.004))).toBe("−0.4");
    expect(deltaPts(d(0))).toBe("±0.0");
  });

  test("the unit is only spelled out in the headline variant", () => {
    // Table cells stay narrow — the unit lives in the column header.
    expect(deltaPts(d(0.018))).not.toContain("pts");
    expect(deltaPtsLabeled(d(0.018))).toBe("+1.8 pts");
  });

  test("a null delta is an em dash, never a fabricated zero", () => {
    expect(deltaPts(d(null))).toBe("—");
    expect(deltaPtsLabeled(d(null))).toBe("—");
  });

  test("the sign uses a true minus sign, not a hyphen", () => {
    expect(deltaPts(d(-0.02))).toBe("−2.0");
    expect(deltaPts(d(-0.02)).startsWith("-")).toBe(false);
  });
});

describe("deltaScore — accuracy deltas in score units", () => {
  test("2 dp in the metric's own units (a 1–5 score, not points)", () => {
    expect(deltaScore(d(0.2))).toBe("+0.20");
    expect(deltaScore(d(-0.05))).toBe("−0.05");
    expect(deltaScore(d(0))).toBe("±0.00");
    expect(deltaScore(d(null))).toBe("—");
  });
});

describe("deltaCount — neutral count deltas", () => {
  test("whole units, always signed", () => {
    expect(deltaCount(d(12))).toBe("+12");
    expect(deltaCount(d(-3))).toBe("−3");
    expect(deltaCount(d(0))).toBe("±0");
    expect(deltaCount(d(null))).toBe("—");
  });
});

describe("deltaClass — green = gain, red = loss", () => {
  test("direction maps onto the semantic modifier", () => {
    expect(deltaClass(d(0.02))).toBe(`${HEADLINE_DELTA} ${HEADLINE_DELTA}--up`);
    expect(deltaClass(d(-0.02))).toBe(
      `${HEADLINE_DELTA} ${HEADLINE_DELTA}--down`,
    );
    expect(deltaClass(d(0))).toBe(`${HEADLINE_DELTA} ${HEADLINE_DELTA}--flat`);
  });

  test("a null delta gets the neutral 'flat' treatment, never green or red", () => {
    expect(deltaClass(d(null))).toBe(
      `${HEADLINE_DELTA} ${HEADLINE_DELTA}--flat`,
    );
  });

  test("the compact table variant carries the same semantics", () => {
    expect(deltaClass(d(0.02), TABLE_DELTA)).toBe(
      `${TABLE_DELTA} ${TABLE_DELTA}--up`,
    );
  });

  test("an inverted (lower-is-better) delta colors by its corrected direction", () => {
    // The error-rate delta arrives polarity-corrected from metrics.ts: a
    // *positive* absolute carrying direction "down" must render red.
    const risingErrorRate: Delta = { absolute: 0.06, direction: "down" };
    expect(deltaClass(risingErrorRate, TABLE_DELTA)).toBe(
      `${TABLE_DELTA} ${TABLE_DELTA}--down`,
    );
    // …while its rendered value keeps the true (positive) sign.
    expect(deltaPts(risingErrorRate)).toBe("+6.0");
  });

  test("count and new markers are their own, non-signal treatments", () => {
    expect(neutralDeltaClass()).toBe(`${TABLE_DELTA} ${TABLE_DELTA}--neutral`);
    expect(newDeltaClass()).toBe(`${TABLE_DELTA} ${TABLE_DELTA}--new`);
  });
});
