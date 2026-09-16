import { describe, expect, test } from "bun:test";
import {
  type TooltipCandidate,
  tooltipRows,
} from "../src/lib/trend-chart-view";

// The tooltip's cap-and-sort decides whether a *drawn* line's value is actually
// readable. The brand's share-of-voice line (issue #40) is pinned so the cap can
// only ever trim competitors — a line you can see but whose number you can't read
// doesn't answer "where do we sit".

const c = (
  label: string,
  v: number | null,
  pinned = false,
): TooltipCandidate => ({ label, color: "#000", v, pinned });

describe("tooltipRows", () => {
  test("sorts by value descending and caps", () => {
    const rows = tooltipRows([c("a", 0.1), c("b", 0.9), c("c", 0.5)], 2);
    expect(rows.map((r) => r.label)).toEqual(["b", "c"]);
  });

  test("drops gaps (null/undefined) rather than plotting them as zero", () => {
    const rows = tooltipRows(
      [c("a", null), { label: "b", color: "#000", v: undefined }, c("c", 0.5)],
      10,
    );
    expect(rows.map((r) => r.label)).toEqual(["c"]);
  });

  test("a pinned series survives the cap even when it ranks last", () => {
    // 12 competitors all outranking the brand, cap of 12: without pinning the
    // brand row would be sliced off entirely.
    const competitors = Array.from({ length: 12 }, (_, i) =>
      c(`competitor-${i}`, 0.5 + i / 100),
    );
    const rows = tooltipRows([...competitors, c("Taskwell", 0.01, true)], 12);
    expect(rows).toHaveLength(12);
    expect(rows[0]?.label).toBe("Taskwell");
    // The cap trimmed a competitor, not the brand.
    expect(rows.map((r) => r.label)).not.toContain("competitor-0");
  });

  test("a pinned series leads even when it ranks first on value anyway", () => {
    const rows = tooltipRows([c("a", 0.9), c("Taskwell", 0.95, true)], 10);
    expect(rows[0]?.label).toBe("Taskwell");
  });

  test("a pinned series with no value at this run is still dropped (a gap is a gap)", () => {
    const rows = tooltipRows([c("a", 0.4), c("Taskwell", null, true)], 10);
    expect(rows.map((r) => r.label)).toEqual(["a"]);
  });

  test("with nothing pinned, ordering is pure value descending (unchanged behavior)", () => {
    const rows = tooltipRows([c("a", 0.2), c("b", 0.8), c("c", 0.5)], 10);
    expect(rows.map((r) => r.label)).toEqual(["b", "c", "a"]);
  });
});
