import { describe, expect, test } from "bun:test";
import type { DrilldownRow } from "@aio/db";
import {
  DEFAULT_VIEW,
  type DrilldownView,
  THEME_NONE,
  applyDrilldownView,
  filterRows,
  sortRows,
  themeOptions,
} from "../src/lib/drilldown-view";

// Fixture rows shaped exactly like a `results ⟕ verdicts ⋈ prompts` SELECT, so
// the pure view logic tested here is the logic the live list runs.
const row = (over: Partial<DrilldownRow> = {}): DrilldownRow => ({
  resultId: "r",
  promptId: "p",
  promptText: "prompt",
  hasError: false,
  runBrandedType: "branded",
  runTheme: "Pricing",
  mentioned: false,
  accuracyScore: null,
  ownedCited: false,
  othersPresent: false,
  brandRank: "not_ranked",
  ...over,
});

const view = (over: Partial<DrilldownView> = {}): DrilldownView => ({
  ...DEFAULT_VIEW,
  ...over,
});

describe("filterRows", () => {
  test("tri-state mentioned excludes null (no-verdict) rows from yes/no", () => {
    const rows = [
      row({ resultId: "a", mentioned: true }),
      row({ resultId: "b", mentioned: false }),
      row({ resultId: "c", mentioned: null, hasError: true }),
    ];
    expect(
      filterRows(rows, view({ mentioned: "yes" })).map((r) => r.resultId),
    ).toEqual(["a"]);
    expect(
      filterRows(rows, view({ mentioned: "no" })).map((r) => r.resultId),
    ).toEqual(["b"]);
    expect(filterRows(rows, view({ mentioned: "all" })).length).toBe(3);
  });

  test("cited and rank filters compose", () => {
    const rows = [
      row({ resultId: "a", ownedCited: true, brandRank: "1" }),
      row({ resultId: "b", ownedCited: true, brandRank: "2" }),
      row({ resultId: "c", ownedCited: false, brandRank: "1" }),
    ];
    const out = filterRows(rows, view({ cited: "yes", rank: "1" }));
    expect(out.map((r) => r.resultId)).toEqual(["a"]);
  });

  test("theme filter: concrete value and the null bucket", () => {
    const rows = [
      row({ resultId: "a", runTheme: "Pricing" }),
      row({ resultId: "b", runTheme: "Security" }),
      row({ resultId: "c", runTheme: null }),
    ];
    expect(
      filterRows(rows, view({ theme: "Security" })).map((r) => r.resultId),
    ).toEqual(["b"]);
    expect(
      filterRows(rows, view({ theme: THEME_NONE })).map((r) => r.resultId),
    ).toEqual(["c"]);
  });
});

describe("sortRows", () => {
  test("accuracy ascending puts nulls last; desc keeps nulls last", () => {
    const rows = [
      row({ resultId: "hi", accuracyScore: 5 }),
      row({ resultId: "none", accuracyScore: null }),
      row({ resultId: "lo", accuracyScore: 2 }),
    ];
    expect(
      sortRows(rows, view({ sortKey: "accuracy", sortDir: "asc" })).map(
        (r) => r.resultId,
      ),
    ).toEqual(["lo", "hi", "none"]);
    expect(
      sortRows(rows, view({ sortKey: "accuracy", sortDir: "desc" })).map(
        (r) => r.resultId,
      ),
    ).toEqual(["hi", "lo", "none"]);
  });

  test("rank sorts 1<2<3<not_ranked<null", () => {
    const rows = [
      row({ resultId: "nr", brandRank: "not_ranked" }),
      row({ resultId: "first", brandRank: "1" }),
      row({ resultId: "none", brandRank: null }),
      row({ resultId: "third", brandRank: "3" }),
    ];
    expect(
      sortRows(rows, view({ sortKey: "rank" })).map((r) => r.resultId),
    ).toEqual(["first", "third", "nr", "none"]);
  });

  test("does not mutate the input array", () => {
    const rows = [
      row({ resultId: "b", promptText: "b" }),
      row({ resultId: "a", promptText: "a" }),
    ];
    const before = rows.map((r) => r.resultId);
    sortRows(rows, view({ sortKey: "prompt" }));
    expect(rows.map((r) => r.resultId)).toEqual(before);
  });
});

describe("themeOptions", () => {
  test("distinct themes alphabetical + null bucket flag", () => {
    const rows = [
      row({ runTheme: "Security" }),
      row({ runTheme: "Pricing" }),
      row({ runTheme: "Security" }),
      row({ runTheme: null }),
    ];
    expect(themeOptions(rows)).toEqual({
      themes: ["Pricing", "Security"],
      hasNone: true,
    });
  });
});

describe("applyDrilldownView", () => {
  test("filters then sorts", () => {
    const rows = [
      row({ resultId: "a", mentioned: true, accuracyScore: 3 }),
      row({ resultId: "b", mentioned: true, accuracyScore: 5 }),
      row({ resultId: "c", mentioned: false, accuracyScore: null }),
    ];
    const out = applyDrilldownView(
      rows,
      view({ mentioned: "yes", sortKey: "accuracy", sortDir: "desc" }),
    );
    expect(out.map((r) => r.resultId)).toEqual(["b", "a"]);
  });
});
