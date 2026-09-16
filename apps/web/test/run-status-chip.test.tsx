import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunStatusChip } from "../src/components/RunStatusChip";
import type { RunCounts } from "../src/lib/run-health";

// The bug in issue #28 was not a wrong formula — it was two pages answering the
// same question separately. So the test that matters is the one that renders
// *both* chips from the same row and compares them. Rendering (rather than
// calling `runHealth` twice) is the point: it goes through the surface each page
// actually uses.

const run = (over: Partial<RunCounts> = {}): RunCounts => ({
  resultCount: 96,
  verdictCount: 96,
  orphanVerdictCount: 0,
  status: "ok",
  ...over,
});

/** 2026-08-03 in the seed corpus — `exa` errored on all 16 attempts. */
const OUTAGE = run({ verdictCount: 80 });
/** 2026-07-27, the adjacent week — nothing missing. */
const CLEAN = run();

/** The chip's visible word, with the class names stripped. */
const label = (markup: string): string => markup.replace(/<[^>]*>/g, "").trim();

const render = (r: RunCounts, variant: "fresh" | "runs") =>
  renderToStaticMarkup(<RunStatusChip run={r} variant={variant} />);

describe("the two pages agree about the same run", () => {
  test("the outage week reads the same on /runs as on the scoreboard", () => {
    expect(label(render(OUTAGE, "runs"))).toBe("partial");
    expect(label(render(OUTAGE, "fresh"))).toBe("partial");
  });

  test("and so does a clean week — agreement in both directions", () => {
    expect(label(render(CLEAN, "runs"))).toBe("ok");
    expect(label(render(CLEAN, "fresh"))).toBe("ok");
  });

  test("an orphan run reads the same on both", () => {
    const orphaned = run({ orphanVerdictCount: 2, status: "ok_with_orphans" });
    expect(label(render(orphaned, "runs"))).toBe(
      label(render(orphaned, "fresh")),
    );
  });
});

describe("the chip's colour follows its word", () => {
  test("a partial run is warned about on both pages, never styled as ok", () => {
    expect(render(OUTAGE, "runs")).toContain("runs__status--warn");
    expect(render(OUTAGE, "runs")).not.toContain("runs__status--ok");
    expect(render(OUTAGE, "fresh")).toContain("fresh__status--warn");
    expect(render(OUTAGE, "fresh")).not.toContain("fresh__status--ok");
  });

  test("a clean run is styled ok on both pages", () => {
    expect(render(CLEAN, "runs")).toContain("runs__status--ok");
    expect(render(CLEAN, "fresh")).toContain("fresh__status--ok");
  });
});
