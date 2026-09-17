import { describe, expect, test } from "bun:test";
import { SYNTHETIC_MARKER, isSyntheticScope } from "../src/lib/synthetic-view";

// `isSyntheticScope` is the one place the header marker's presence is decided
// (like run-health.ts for a run's status, issue #28). Every page routes through
// it, so a page cannot quietly disagree with another about whether what it shows
// was measured.
//
// Run dates are the seed corpus's own: 2026-09-14 is its latest run, 2026-09-07
// the prior one the scoreboard deltas against.
const SEEDED = ["2026-09-14", "2026-09-07", "2026-08-31"];

describe("a corpus with no synthetic runs", () => {
  test("marks nothing, whatever the page is scoped to", () => {
    expect(isSyntheticScope([], "2026-09-14")).toBe(false);
    expect(isSyntheticScope([])).toBe(false);
    expect(isSyntheticScope([], null)).toBe(false);
    expect(isSyntheticScope([], ["2026-09-14", undefined])).toBe(false);
  });
});

describe("a page scoped to named runs", () => {
  test("a flagged run is marked", () => {
    expect(isSyntheticScope(SEEDED, "2026-09-14")).toBe(true);
  });

  test("an unflagged run is not marked, even alongside flagged runs", () => {
    // The case that makes the marker mean something: with a real run selected on
    // a mixed corpus, the marker has to disappear.
    expect(isSyntheticScope(SEEDED, "2026-05-11")).toBe(false);
  });

  test("the scoreboard is marked when only its prior (delta base) run is flagged", () => {
    // A real run whose week-over-week delta is computed against a seeded one is
    // showing an invented number in its deltas.
    expect(isSyntheticScope(SEEDED, ["2026-05-11", "2026-08-31"])).toBe(true);
  });

  test("a run that has not resolved yet does not mark the page", () => {
    // An empty database (no active run) renders a placeholder, not data.
    expect(isSyntheticScope(SEEDED, [undefined, undefined])).toBe(false);
  });
});

describe("a page that pools the whole corpus", () => {
  test("is marked when any ingested run is synthetic", () => {
    // /prompts, a trajectory, the competitive and cited trends and /runs all draw
    // across every run, so a seeded run anywhere in the corpus is on screen.
    expect(isSyntheticScope(SEEDED)).toBe(true);
  });
});

describe("the marker's wording", () => {
  test("says the numbers are invented, in a sentence that stands alone", () => {
    // It has to be readable in a screenshot with no surrounding context.
    expect(SYNTHETIC_MARKER).toContain("Synthetic data");
    expect(SYNTHETIC_MARKER).toContain("invented");
  });
});
