import { describe, expect, test } from "bun:test";
import {
  type CompetitiveRunRow,
  type MetricRow,
  NO_DELTAS,
  type ScopedRow,
  brandShareOfVoice,
  brandShareOfVoiceTrend,
  competitiveByRun,
  countDropped,
  coverageByProvider,
  filterBySegment,
  filterByTheme,
  headlineDeltas,
  headlineMetrics,
  invertDirection,
  metricDelta,
  metricsByProvider,
  metricsByTheme,
  ownedCitationByRun,
  ownedCitationReach,
  ownedUrlsByFrequency,
  promptSparklines,
  promptTrajectoryByProvider,
  rankDistribution,
  shareOfVoice,
  shareOfVoiceTrend,
  withCoverageDeltas,
  withProviderDeltas,
  withThemeDeltas,
} from "../src/metrics.js";
import type { PromptMentionRow, PromptTrajectoryRow } from "../src/metrics.js";

// Pure aggregation over small fixture rows (never the real corpus). These rows
// have the same shape as a `results ⟕ verdicts` SELECT, so the logic tested
// here is exactly the logic the live scoreboard runs.

// A fully-specified error-free, unmentioned row. Spread + override to vary one
// field at a time without restating the whole shape.
const row = (over: Partial<MetricRow> = {}): MetricRow => ({
  hasError: false,
  mentioned: false,
  accuracyScore: null,
  ownedCited: false,
  othersPresent: false,
  brandRank: "not_ranked",
  ...over,
});

describe("headlineMetrics — cohort funnel + denominators", () => {
  test("All cohort N = error-free results; errored rows excluded from every cohort", () => {
    const m = headlineMetrics([
      row({ mentioned: true, accuracyScore: 4 }),
      row({ mentioned: false }),
      // A flake: errored but (impossibly) flagged mentioned/cited — still must
      // not leak into any cohort or denominator.
      row({
        hasError: true,
        mentioned: true,
        ownedCited: true,
        othersPresent: true,
        brandRank: "1",
        accuracyScore: 5,
      }),
    ]);
    expect(m.funnel.all).toBe(2);
    expect(m.funnel.mentioned).toBe(1);
    expect(m.funnel.competitive).toBe(0);
    expect(m.funnel.cited).toBe(0);
    expect(m.mentionRate.denominator).toBe(2);
    expect(m.mentionRate.rate).toBe(0.5);
  });

  test("a non-errored result with no verdict (LEFT JOIN miss) is in N but no numerator", () => {
    const m = headlineMetrics([
      row({ mentioned: true, accuracyScore: 5, ownedCited: true }),
      // join miss: every verdict field null, but error-free → counts toward N
      {
        hasError: false,
        mentioned: null,
        accuracyScore: null,
        ownedCited: null,
        othersPresent: null,
        brandRank: null,
      },
    ]);
    expect(m.funnel.all).toBe(2);
    expect(m.mentionRate.numerator).toBe(1);
    expect(m.mentionRate.rate).toBe(0.5);
    expect(m.ownedCitationRate.numerator).toBe(1);
    expect(m.ownedCitationRate.rate).toBe(0.5);
  });

  test("rates are null (undefined) when their cohort is empty — never divide by zero", () => {
    const empty = headlineMetrics([]);
    expect(empty.mentionRate.rate).toBeNull();
    expect(empty.ownedCitationRate.rate).toBeNull();
    expect(empty.firstPlaceRate.rate).toBeNull();
    expect(empty.avgAccuracy.mean).toBeNull();

    // All errored → All cohort empty, every rate undefined.
    const allErrored = headlineMetrics([row({ hasError: true })]);
    expect(allErrored.mentionRate.rate).toBeNull();
  });
});

describe("headlineMetrics — avg accuracy over the Mentioned cohort", () => {
  test("mean is over mentioned results carrying a score; count is shown", () => {
    const m = headlineMetrics([
      row({ mentioned: true, accuracyScore: 4 }),
      row({ mentioned: true, accuracyScore: 2 }),
      row({ mentioned: false, accuracyScore: null }), // not mentioned → ignored
    ]);
    expect(m.avgAccuracy.mean).toBe(3);
    expect(m.avgAccuracy.count).toBe(2);
  });

  test("a mentioned result with a null score is dropped from the mean (not counted as 0)", () => {
    const m = headlineMetrics([
      row({ mentioned: true, accuracyScore: 5 }),
      row({ mentioned: true, accuracyScore: null }), // mentioned but unscored
    ]);
    expect(m.avgAccuracy.mean).toBe(5);
    expect(m.avgAccuracy.count).toBe(1);
  });
});

describe("headlineMetrics — owned-citation rate over All", () => {
  test("count(owned_cited) / All — denominator is the All cohort, not Mentioned", () => {
    const m = headlineMetrics([
      row({ mentioned: true, ownedCited: true }),
      row({ mentioned: false, ownedCited: true }), // cited without a mention
      row({ mentioned: true, ownedCited: false }),
      row({ mentioned: false, ownedCited: false }),
    ]);
    expect(m.funnel.cited).toBe(2);
    expect(m.ownedCitationRate.numerator).toBe(2);
    expect(m.ownedCitationRate.denominator).toBe(4); // All, not Mentioned
    expect(m.ownedCitationRate.rate).toBe(0.5);
  });
});

describe("headlineMetrics — 1st-place rate over the Competitive subset", () => {
  test("count(brand_rank=1) / count(others_present=true) — competitive denominator", () => {
    const m = headlineMetrics([
      row({ mentioned: true, othersPresent: true, brandRank: "1" }),
      row({ mentioned: true, othersPresent: true, brandRank: "2" }),
      row({ mentioned: true, othersPresent: true, brandRank: "3" }),
      // Mentioned but no competitors present → outside the competitive cohort.
      row({ mentioned: true, othersPresent: false, brandRank: "not_ranked" }),
    ]);
    expect(m.funnel.competitive).toBe(3);
    expect(m.firstPlaceRate.numerator).toBe(1);
    expect(m.firstPlaceRate.denominator).toBe(3); // competitive subset only
    expect(m.firstPlaceRate.rate).toBeCloseTo(1 / 3);
  });

  test("rate is null when no answer is competitive (empty denominator)", () => {
    const m = headlineMetrics([
      row({ mentioned: true, othersPresent: false }),
      row({ mentioned: false }),
    ]);
    expect(m.firstPlaceRate.denominator).toBe(0);
    expect(m.firstPlaceRate.rate).toBeNull();
  });

  test("a brand_rank=1 outside the competitive cohort never escapes the denominator (rate ≤ 1)", () => {
    // Upstream judging emits brand_rank='1' on a row with no competitors
    // present — it must not inflate the numerator past its own denominator.
    const m = headlineMetrics([
      row({ mentioned: true, othersPresent: true, brandRank: "1" }),
      row({ mentioned: true, othersPresent: false, brandRank: "1" }),
    ]);
    expect(m.firstPlaceRate.numerator).toBe(1); // only the competitive one
    expect(m.firstPlaceRate.denominator).toBe(1);
    expect(m.firstPlaceRate.rate).toBe(1);
    expect(m.firstPlaceRate.numerator).toBeLessThanOrEqual(
      m.firstPlaceRate.denominator,
    );
  });
});

describe("coverageByProvider — failed runs surfaced per provider, not hidden", () => {
  test("attempted/errored/error-rate per provider, sorted by name", () => {
    const cov = coverageByProvider([
      { provider: "openai", hasError: false },
      { provider: "openai", hasError: true },
      { provider: "anthropic", hasError: false },
      { provider: "anthropic", hasError: false },
      { provider: "perplexity", hasError: true },
    ]);
    expect(cov.map((c) => c.provider)).toEqual([
      "anthropic",
      "openai",
      "perplexity",
    ]);
    expect(cov[0]).toEqual({
      provider: "anthropic",
      attempted: 2,
      errored: 0,
      errorRate: 0,
    });
    expect(cov[1]).toEqual({
      provider: "openai",
      attempted: 2,
      errored: 1,
      errorRate: 0.5,
    });
    expect(cov[2]).toEqual({
      provider: "perplexity",
      attempted: 1,
      errored: 1,
      errorRate: 1,
    });
  });

  test("no rows → no providers", () => {
    expect(coverageByProvider([])).toEqual([]);
  });
});

// A scoped fixture row: the headline shape plus the segment/theme classification
// the scoreboard filters and groups by.
const srow = (over: Partial<ScopedRow> = {}): ScopedRow => ({
  hasError: false,
  mentioned: false,
  accuracyScore: null,
  ownedCited: false,
  othersPresent: false,
  brandRank: "not_ranked",
  runBrandedType: "branded",
  runTheme: "Alternatives",
  ...over,
});

describe("filterBySegment — the segment axis re-scopes the rows", () => {
  test("global is a no-op (every row passes, regardless of branded_type)", () => {
    const rows = [
      srow({ runBrandedType: "branded" }),
      srow({ runBrandedType: "unbranded" }),
      srow({ runBrandedType: null }),
    ];
    expect(filterBySegment(rows, "global")).toHaveLength(3);
  });

  test("branded / unbranded keep only the matching branded_type", () => {
    const rows = [
      srow({ runBrandedType: "branded" }),
      srow({ runBrandedType: "unbranded" }),
      srow({ runBrandedType: "unbranded" }),
      srow({ runBrandedType: null }), // unclassified → in neither segment
    ];
    expect(filterBySegment(rows, "branded")).toHaveLength(1);
    expect(filterBySegment(rows, "unbranded")).toHaveLength(2);
  });

  test("the headline computed over a scoped slice differs from the global pool", () => {
    const rows = [
      // Branded: 2 mentioned of 2 → 100%.
      srow({ runBrandedType: "branded", mentioned: true }),
      srow({ runBrandedType: "branded", mentioned: true }),
      // Unbranded: 0 mentioned of 2 → 0%.
      srow({ runBrandedType: "unbranded", mentioned: false }),
      srow({ runBrandedType: "unbranded", mentioned: false }),
    ];
    expect(headlineMetrics(rows).mentionRate.rate).toBe(0.5); // global pool
    expect(
      headlineMetrics(filterBySegment(rows, "branded")).mentionRate.rate,
    ).toBe(1);
    expect(
      headlineMetrics(filterBySegment(rows, "unbranded")).mentionRate.rate,
    ).toBe(0);
  });
});

describe("metricsByTheme — segment × theme cross-tab", () => {
  test("one full headline per theme, each over only that theme's rows", () => {
    const themes = metricsByTheme([
      srow({ runTheme: "Alternatives", mentioned: true, accuracyScore: 4 }),
      srow({ runTheme: "Alternatives", mentioned: false }),
      srow({ runTheme: "Authorization", mentioned: true, accuracyScore: 2 }),
    ]);
    const alt = themes.find((t) => t.theme === "Alternatives");
    const auth = themes.find((t) => t.theme === "Authorization");
    expect(alt?.funnel.all).toBe(2);
    expect(alt?.mentionRate.rate).toBe(0.5);
    expect(alt?.avgAccuracy.mean).toBe(4);
    expect(auth?.funnel.all).toBe(1);
    expect(auth?.mentionRate.rate).toBe(1);
  });

  test("themes are sorted by name with the null-theme bucket last", () => {
    const themes = metricsByTheme([
      srow({ runTheme: "Beta" }),
      srow({ runTheme: null }),
      srow({ runTheme: "Alpha" }),
    ]);
    expect(themes.map((t) => t.theme)).toEqual(["Alpha", "Beta", null]);
  });

  test("composes with the segment: break a scoped slice down by theme", () => {
    const rows = [
      srow({
        runBrandedType: "unbranded",
        runTheme: "Alternatives",
        mentioned: true,
      }),
      srow({
        runBrandedType: "unbranded",
        runTheme: "Authorization",
        mentioned: false,
      }),
      // Branded rows must not leak into the unbranded × theme cross-tab.
      srow({
        runBrandedType: "branded",
        runTheme: "Alternatives",
        mentioned: true,
      }),
    ];
    const themes = metricsByTheme(filterBySegment(rows, "unbranded"));
    expect(themes.map((t) => t.theme)).toEqual([
      "Alternatives",
      "Authorization",
    ]);
    expect(themes.find((t) => t.theme === "Alternatives")?.funnel.all).toBe(1);
  });

  test("errored rows are dropped from every theme cohort (as in the pooled headline)", () => {
    const themes = metricsByTheme([
      srow({ runTheme: "Alternatives", mentioned: true }),
      srow({ runTheme: "Alternatives", hasError: true, mentioned: true }),
    ]);
    const alt = themes.find((t) => t.theme === "Alternatives");
    expect(alt?.funnel.all).toBe(1); // errored row excluded
    expect(alt?.mentionRate.rate).toBe(1);
  });

  test("no rows → no theme rows", () => {
    expect(metricsByTheme([])).toEqual([]);
  });
});

describe("metricsByProvider — per-provider headline breakdown", () => {
  // The per-provider rows carry a provider tag on the plain headline shape.
  const prow = (
    provider: string,
    over: Partial<MetricRow> = {},
  ): MetricRow & { provider: string } => ({
    hasError: false,
    mentioned: false,
    accuracyScore: null,
    ownedCited: false,
    othersPresent: false,
    brandRank: "not_ranked",
    provider,
    ...over,
  });

  test("one full headline per provider, each over only that provider's rows", () => {
    const providers = metricsByProvider([
      prow("openai", { mentioned: true, accuracyScore: 4 }),
      prow("openai", { mentioned: false }),
      prow("anthropic", { mentioned: true, accuracyScore: 2 }),
    ]);
    const openai = providers.find((p) => p.provider === "openai");
    const anthropic = providers.find((p) => p.provider === "anthropic");
    expect(openai?.funnel.all).toBe(2);
    expect(openai?.mentionRate.rate).toBe(0.5);
    expect(openai?.avgAccuracy.mean).toBe(4);
    expect(anthropic?.funnel.all).toBe(1);
    expect(anthropic?.mentionRate.rate).toBe(1);
  });

  test("providers are sorted by name", () => {
    const providers = metricsByProvider([
      prow("perplexity"),
      prow("anthropic"),
      prow("openai"),
    ]);
    expect(providers.map((p) => p.provider)).toEqual([
      "anthropic",
      "openai",
      "perplexity",
    ]);
  });

  test("errored rows are dropped from every provider cohort (as in the pooled headline)", () => {
    const providers = metricsByProvider([
      prow("openai", { mentioned: true }),
      prow("openai", { hasError: true, mentioned: true }),
    ]);
    const openai = providers.find((p) => p.provider === "openai");
    expect(openai?.funnel.all).toBe(1); // errored row excluded
    expect(openai?.mentionRate.rate).toBe(1);
  });

  test("the per-provider rate matches the pooled rate over the same rows", () => {
    // A provider breakdown is the pooled headline partitioned by provider: a
    // single-provider corpus must give identical numbers either way.
    const rows = [
      prow("openai", { mentioned: true, ownedCited: true }),
      prow("openai", { mentioned: false }),
    ];
    const [only] = metricsByProvider(rows);
    const pooled = headlineMetrics(rows);
    expect(only.mentionRate).toEqual(pooled.mentionRate);
    expect(only.ownedCitationRate).toEqual(pooled.ownedCitationRate);
  });

  test("no rows → no provider rows", () => {
    expect(metricsByProvider([])).toEqual([]);
  });
});

describe("metricDelta — week-over-week, shared by every headline metric", () => {
  test("positive delta is 'up', negative is 'down', equal is 'flat'", () => {
    const up = metricDelta(0.6, 0.4);
    expect(up.absolute).toBeCloseTo(0.2);
    expect(up.direction).toBe("up");

    const down = metricDelta(0.4, 0.6);
    expect(down.absolute).toBeCloseTo(-0.2);
    expect(down.direction).toBe("down");

    const flat = metricDelta(0.5, 0.5);
    expect(flat.absolute).toBe(0);
    expect(flat.direction).toBe("flat");
  });

  test("works in the metric's own units (accuracy scores, not just rates)", () => {
    const d = metricDelta(4.2, 3.7);
    expect(d.absolute).toBeCloseTo(0.5);
    expect(d.direction).toBe("up");
  });

  test("null delta when there is no prior run, or either value is undefined", () => {
    expect(metricDelta(0.5, null)).toEqual({ absolute: null, direction: null });
    expect(metricDelta(0.5, undefined)).toEqual({
      absolute: null,
      direction: null,
    });
    expect(metricDelta(null, 0.5)).toEqual({ absolute: null, direction: null });
  });

  test("a retroactively changed prior run changes the delta (computed live, not cached)", () => {
    const current = headlineMetrics([
      row({ mentioned: true }),
      row({ mentioned: true }),
      row({ mentioned: false }),
      row({ mentioned: false }),
    ]).mentionRate.rate; // 0.50

    // Prior run as originally judged: 0.25 → current is up 25 pts.
    const priorBefore = headlineMetrics([
      row({ mentioned: true }),
      row({ mentioned: false }),
      row({ mentioned: false }),
      row({ mentioned: false }),
    ]).mentionRate.rate;
    const before = metricDelta(current, priorBefore);
    expect(before.absolute).toBeCloseTo(0.25);
    expect(before.direction).toBe("up");

    // Same prior run re-judged later (two more mentions found): 0.75 → the delta
    // recomputes to current being *down* 25 pts. No precomputed comparison file
    // could capture this; the rate is derived from rows.
    const priorAfter = headlineMetrics([
      row({ mentioned: true }),
      row({ mentioned: true }),
      row({ mentioned: true }),
      row({ mentioned: false }),
    ]).mentionRate.rate;
    const after = metricDelta(current, priorAfter);
    expect(after.absolute).toBeCloseTo(-0.25);
    expect(after.direction).toBe("down");
  });
});

// ── Per-key WoW deltas in every scoreboard table (issue #40) ─────────────────

describe("headlineDeltas — one delta computation for headline and every row", () => {
  const mk = (mentioned: number, all: number, accuracy: number | null) =>
    headlineMetrics([
      ...Array.from({ length: mentioned }, () =>
        row({ mentioned: true, accuracyScore: accuracy }),
      ),
      ...Array.from({ length: all - mentioned }, () => row()),
    ]);

  test("all four metrics, each in its own units", () => {
    // current: 2/4 mentioned @ 4.0; prior: 1/4 mentioned @ 3.0
    const d = headlineDeltas(mk(2, 4, 4), mk(1, 4, 3));
    expect(d.mentionRate.absolute).toBeCloseTo(0.25);
    expect(d.mentionRate.direction).toBe("up");
    // Accuracy is a 1–5 score, so its delta is in score units, not points.
    expect(d.avgAccuracy.absolute).toBeCloseTo(1);
    expect(d.avgAccuracy.direction).toBe("up");
  });

  test("no prior counterpart → every metric null (never a fabricated 0)", () => {
    const d = headlineDeltas(mk(2, 4, 4), null);
    expect(d).toEqual(NO_DELTAS);
    expect(d.mentionRate.absolute).toBeNull();
    expect(d.mentionRate.direction).toBeNull();
  });

  test("an empty cohort on either side nulls that metric alone", () => {
    // No mentioned rows either side → avg accuracy undefined, mention rate 0.
    const d = headlineDeltas(mk(0, 4, null), mk(0, 2, null));
    expect(d.avgAccuracy.absolute).toBeNull();
    expect(d.mentionRate.absolute).toBe(0);
    expect(d.mentionRate.direction).toBe("flat");
  });
});

describe("invertDirection — lower-is-better polarity (the error rate)", () => {
  test("a rising error rate reads as a loss, with its sign untouched", () => {
    const d = invertDirection(metricDelta(0.08, 0.02));
    expect(d.absolute).toBeCloseTo(0.06); // still positive: errors went *up*
    expect(d.direction).toBe("down"); // …but that's bad → renders red
  });

  test("a falling error rate reads as a gain", () => {
    const d = invertDirection(metricDelta(0.02, 0.08));
    expect(d.absolute).toBeCloseTo(-0.06);
    expect(d.direction).toBe("up");
  });

  test("flat and null deltas pass through unchanged", () => {
    expect(invertDirection(metricDelta(0.05, 0.05)).direction).toBe("flat");
    expect(invertDirection(metricDelta(0.05, null))).toEqual({
      absolute: null,
      direction: null,
    });
  });
});

describe("per-key delta join — provider / theme / coverage rows", () => {
  const prow = (provider: string, mentioned: number, all: number) => ({
    provider,
    ...headlineMetrics([
      ...Array.from({ length: mentioned }, () => row({ mentioned: true })),
      ...Array.from({ length: all - mentioned }, () => row()),
    ]),
  });

  test("a key present in both runs gets a real delta, in the same scope", () => {
    const [openai] = withProviderDeltas(
      [prow("openai", 3, 4)],
      [prow("openai", 1, 4)],
    );
    expect(openai?.deltas.kind).toBe("delta");
    if (openai?.deltas.kind !== "delta") throw new Error("expected a delta");
    expect(openai.deltas.metrics.mentionRate.absolute).toBeCloseTo(0.5);
    expect(openai.deltas.metrics.mentionRate.direction).toBe("up");
    // The All-count delta explains the rate move; it's carried, sign and all.
    expect(openai.deltas.all.absolute).toBe(0);
  });

  test("a key new in the active run is 'new', not a null delta", () => {
    const rows = withProviderDeltas(
      [prow("openai", 1, 2), prow("exa", 1, 2)],
      [prow("openai", 1, 2)],
    );
    expect(rows.find((r) => r.provider === "exa")?.deltas.kind).toBe("new");
    expect(rows.find((r) => r.provider === "openai")?.deltas.kind).toBe(
      "delta",
    );
  });

  test("no prior run at all is 'none' — distinct from a new key", () => {
    const [only] = withProviderDeltas([prow("openai", 1, 2)], null);
    expect(only?.deltas.kind).toBe("none");
  });

  test("dropped keys get no phantom row; the count is reported separately", () => {
    const active = [prow("openai", 1, 2)];
    const prior = [prow("openai", 1, 2), prow("perplexity", 1, 2)];
    expect(withProviderDeltas(active, prior).map((r) => r.provider)).toEqual([
      "openai",
    ]);
    expect(
      countDropped(
        active.map((r) => r.provider),
        prior.map((r) => r.provider),
      ),
    ).toBe(1);
    // No prior run → nothing can have dropped.
    expect(
      countDropped(
        active.map((r) => r.provider),
        null,
      ),
    ).toBe(0);
  });

  test("themes join by theme, and the null-theme bucket joins to its own", () => {
    const scoped = (theme: string | null, mentioned: number, all: number) => ({
      theme,
      ...headlineMetrics([
        ...Array.from({ length: mentioned }, () => row({ mentioned: true })),
        ...Array.from({ length: all - mentioned }, () => row()),
      ]),
    });
    const rows = withThemeDeltas(
      [scoped("Pricing", 2, 4), scoped(null, 1, 2), scoped("New", 1, 1)],
      [scoped("Pricing", 1, 4), scoped(null, 0, 2)],
    );
    const pricing = rows.find((r) => r.theme === "Pricing");
    if (pricing?.deltas.kind !== "delta") throw new Error("expected a delta");
    expect(pricing.deltas.metrics.mentionRate.absolute).toBeCloseTo(0.25);
    // The null-theme (Uncategorized) bucket matched the prior null-theme bucket
    // rather than falling through as "new".
    const uncategorized = rows.find((r) => r.theme === null);
    if (uncategorized?.deltas.kind !== "delta") {
      throw new Error("expected a delta");
    }
    expect(uncategorized.deltas.metrics.mentionRate.absolute).toBeCloseTo(0.5);
    expect(rows.find((r) => r.theme === "New")?.deltas.kind).toBe("new");
  });

  test("coverage rows carry an inverted error-rate delta and neutral counts", () => {
    const cov = (provider: string, attempted: number, errored: number) => ({
      provider,
      attempted,
      errored,
      errorRate: attempted === 0 ? null : errored / attempted,
    });
    const [openai] = withCoverageDeltas(
      [cov("openai", 100, 8)],
      [cov("openai", 90, 2)],
    );
    if (openai?.deltas.kind !== "delta") throw new Error("expected a delta");
    // Error rate rose 2.2% → 8.0%: a positive absolute reading as a *loss*.
    expect(openai.deltas.errorRate.absolute).toBeGreaterThan(0);
    expect(openai.deltas.errorRate.direction).toBe("down");
    expect(openai.deltas.attempted.absolute).toBe(10);
    expect(openai.deltas.errored.absolute).toBe(6);
  });

  test("coverage: a provider absent from the prior run is 'new'; no prior run is 'none'", () => {
    const cov = { provider: "exa", attempted: 10, errored: 0, errorRate: 0 };
    expect(withCoverageDeltas([cov], [])[0]?.deltas.kind).toBe("new");
    expect(withCoverageDeltas([cov], null)[0]?.deltas.kind).toBe("none");
  });

  test("an empty cohort on either side leaves that metric's delta null", () => {
    // Prior provider run had zero rows → every rate undefined → null deltas,
    // even though the join itself succeeded.
    const empty = { provider: "openai", ...headlineMetrics([]) };
    const [r] = withProviderDeltas([prow("openai", 1, 2)], [empty]);
    if (r?.deltas.kind !== "delta") throw new Error("expected a delta");
    expect(r.deltas.metrics.mentionRate.absolute).toBeNull();
    expect(r.deltas.all.absolute).toBe(2);
  });
});

// ── Competitive landscape (issue #11) ────────────────────────────────────────
// The competitive cohort is `others_present = true`; both metrics take that
// cohort count as their denominator. Fixtures mirror a `results ⟕ verdicts`
// (+ competitor_mentions) SELECT, so the tested logic is the production logic.

// A competitive (or not) row carrying its rank and the competitors mentioned.
const crow = (over: Partial<CompetitiveRunRow> = {}): CompetitiveRunRow => ({
  runDate: "2026-03-30",
  hasError: false,
  othersPresent: true,
  brandRank: "not_ranked",
  mentioned: false,
  competitors: [],
  ...over,
});

describe("rankDistribution — over the competitive cohort", () => {
  test("only others_present rows count; buckets reconcile to the denominator", () => {
    const d = rankDistribution([
      crow({ brandRank: "1" }),
      crow({ brandRank: "1" }),
      crow({ brandRank: "2" }),
      crow({ brandRank: "not_ranked" }),
      // not competitive → excluded from the cohort entirely
      crow({ othersPresent: false, brandRank: "1" }),
    ]);
    expect(d.competitive).toBe(4);
    expect(d.counts).toEqual({ "1": 2, "2": 1, "3": 0, not_ranked: 1 });
    expect(
      d.counts["1"] + d.counts["2"] + d.counts["3"] + d.counts.not_ranked,
    ).toBe(d.competitive);
    expect(d.firstPlaceRate).toBe(0.5);
  });

  test("errored rows are excluded even if flagged competitive", () => {
    const d = rankDistribution([
      crow({ brandRank: "1" }),
      crow({ hasError: true, brandRank: "1" }),
    ]);
    expect(d.competitive).toBe(1);
    expect(d.counts["1"]).toBe(1);
  });

  test("an absent/unknown rank falls into not_ranked (defensive)", () => {
    const d = rankDistribution([
      crow({ brandRank: null }),
      crow({ brandRank: "garbage" }),
    ]);
    expect(d.counts.not_ranked).toBe(2);
    expect(d.competitive).toBe(2);
  });

  test("empty cohort → firstPlaceRate is null, never a divide-by-zero", () => {
    expect(rankDistribution([]).firstPlaceRate).toBeNull();
    expect(
      rankDistribution([crow({ othersPresent: false })]).firstPlaceRate,
    ).toBeNull();
  });
});

describe("shareOfVoice — per competitor over the competitive cohort", () => {
  test("share is mentions / competitive; sorted by mentions desc then name", () => {
    const sov = shareOfVoice([
      crow({ competitors: ["Beta", "Alpha"] }),
      crow({ competitors: ["Alpha"] }),
      crow({ competitors: ["Alpha", "Gamma"] }),
      crow({ competitors: [] }),
    ]);
    expect(sov.competitive).toBe(4);
    expect(sov.competitors).toEqual([
      { competitor: "Alpha", mentions: 3, share: 0.75 },
      { competitor: "Beta", mentions: 1, share: 0.25 },
      { competitor: "Gamma", mentions: 1, share: 0.25 },
    ]);
  });

  test("competitors on a non-competitive or errored row never count", () => {
    const sov = shareOfVoice([
      crow({ competitors: ["Alpha"] }),
      crow({ othersPresent: false, competitors: ["Alpha", "Beta"] }),
      crow({ hasError: true, competitors: ["Beta"] }),
    ]);
    expect(sov.competitive).toBe(1);
    expect(sov.competitors).toEqual([
      { competitor: "Alpha", mentions: 1, share: 1 },
    ]);
  });

  test("a competitor named twice in one result counts once", () => {
    const sov = shareOfVoice([crow({ competitors: ["Alpha", "Alpha"] })]);
    expect(sov.competitors).toEqual([
      { competitor: "Alpha", mentions: 1, share: 1 },
    ]);
  });

  test("empty cohort → no competitors, shares would be null", () => {
    expect(shareOfVoice([]).competitors).toEqual([]);
    expect(shareOfVoice([]).competitive).toBe(0);
  });
});

describe("brandShareOfVoice — the brand on the competitors' denominator", () => {
  test("share is count(mentioned) / competitive — the same denominator shareOfVoice uses", () => {
    const rows = [
      crow({ mentioned: true, competitors: ["Alpha"] }),
      crow({ mentioned: true, competitors: ["Alpha"] }),
      crow({ mentioned: false, competitors: ["Alpha", "Beta"] }),
      crow({ mentioned: false }),
    ];
    const brand = brandShareOfVoice(rows);
    expect(brand.competitive).toBe(4);
    expect(brand.mentions).toBe(2);
    expect(brand.share).toBe(0.5);
    // Read against the identical population as every competitor's share.
    expect(brand.competitive).toBe(shareOfVoice(rows).competitive);
  });

  test("mentioned = null counts as not mentioned — it stays in the denominator", () => {
    const brand = brandShareOfVoice([
      crow({ mentioned: true }),
      crow({ mentioned: null }),
      crow({ mentioned: null }),
    ]);
    expect(brand.competitive).toBe(3);
    expect(brand.mentions).toBe(1);
    expect(brand.share).toBe(1 / 3);
  });

  test("non-competitive and errored rows never enter the cohort", () => {
    const brand = brandShareOfVoice([
      crow({ mentioned: true }),
      crow({ mentioned: true, othersPresent: false }),
      crow({ mentioned: true, hasError: true }),
    ]);
    expect(brand.competitive).toBe(1);
    expect(brand.mentions).toBe(1);
  });

  test("empty cohort → null share, never a divide-by-zero", () => {
    const brand = brandShareOfVoice([]);
    expect(brand.competitive).toBe(0);
    expect(brand.mentions).toBe(0);
    expect(brand.share).toBeNull();
  });

  test("the brand never enters the competitor list (its own share is a sibling)", () => {
    const rows = [crow({ mentioned: true, competitors: ["Alpha"] })];
    expect(shareOfVoice(rows).competitors.map((c) => c.competitor)).toEqual([
      "Alpha",
    ]);
  });
});

describe("brandShareOfVoiceTrend — the brand's per-run series", () => {
  test("one dense point per run, in the trend's ascending run order", () => {
    const points = competitiveByRun([
      crow({ runDate: "2026-04-15", mentioned: true }),
      crow({ runDate: "2026-03-30", mentioned: true }),
      crow({ runDate: "2026-03-30", mentioned: false }),
    ]);
    expect(brandShareOfVoiceTrend(points)).toEqual([
      { runDate: "2026-03-30", mentions: 1, share: 0.5 },
      { runDate: "2026-04-15", mentions: 1, share: 1 },
    ]);
  });
});

describe("competitiveByRun + shareOfVoiceTrend — trends over run dates", () => {
  const rows: CompetitiveRunRow[] = [
    crow({ runDate: "2026-03-30", brandRank: "2", competitors: ["Alpha"] }),
    crow({
      runDate: "2026-03-30",
      brandRank: "1",
      competitors: ["Alpha", "Beta"],
    }),
    crow({ runDate: "2026-04-15", brandRank: "1", competitors: ["Alpha"] }),
    crow({ runDate: "2026-04-15", brandRank: "1", competitors: ["Gamma"] }),
  ];

  test("groups by run, ascending by date, with per-run distribution + SoV", () => {
    const points = competitiveByRun(rows);
    expect(points.map((p) => p.runDate)).toEqual(["2026-03-30", "2026-04-15"]);
    expect(points[0]?.rankDistribution.firstPlaceRate).toBe(0.5);
    expect(points[1]?.rankDistribution.firstPlaceRate).toBe(1);
    expect(points[0]?.shareOfVoice.competitive).toBe(2);
  });

  test("SoV trend pivots into dense per-competitor series, ranked by total", () => {
    const series = shareOfVoiceTrend(competitiveByRun(rows));
    // Alpha leads (3 total), then Beta and Gamma (1 each, alphabetical).
    expect(series.map((s) => s.competitor)).toEqual(["Alpha", "Beta", "Gamma"]);
    const alpha = series[0];
    expect(alpha?.total).toBe(3);
    // Dense: one point per run, in ascending run order.
    expect(alpha?.points.map((p) => [p.runDate, p.mentions])).toEqual([
      ["2026-03-30", 2],
      ["2026-04-15", 1],
    ]);
    // Beta absent in the second run → explicit 0, not a gap.
    const beta = series.find((s) => s.competitor === "Beta");
    expect(beta?.points.map((p) => p.mentions)).toEqual([1, 0]);
    expect(beta?.points[1]?.share).toBe(0);
  });
});

describe("filterByTheme — segment × theme scoping", () => {
  const t = (runTheme: string | null) => ({ runTheme, n: runTheme });
  test("null target is a no-op (every theme)", () => {
    const rows = [t("auth"), t("billing"), t(null)];
    expect(filterByTheme(rows, null)).toHaveLength(3);
  });
  test("a concrete theme keeps only matching rows", () => {
    const rows = [t("auth"), t("billing"), t("auth"), t(null)];
    expect(filterByTheme(rows, "auth")).toEqual([t("auth"), t("auth")]);
  });
});

// ── Owned-citation reach (issue #12) ─────────────────────────────────────────

describe("ownedCitationReach — Cited cohort over the All cohort", () => {
  test("rate is count(owned_cited) / All (error-free); carries cited + all", () => {
    const reach = ownedCitationReach([
      { hasError: false, ownedCited: true },
      { hasError: false, ownedCited: true },
      { hasError: false, ownedCited: false },
      { hasError: false, ownedCited: null }, // verdict join miss → counts toward All only
    ]);
    expect(reach.cited).toBe(2);
    expect(reach.all).toBe(4); // All, not the Cited cohort
    expect(reach.rate).toBe(0.5);
  });

  test("errored rows are excluded from the denominator (a flaking provider is not decline)", () => {
    const reach = ownedCitationReach([
      { hasError: false, ownedCited: true },
      { hasError: true, ownedCited: true }, // dropped from both numerator and denominator
      { hasError: true, ownedCited: false },
    ]);
    expect(reach.cited).toBe(1);
    expect(reach.all).toBe(1);
    expect(reach.rate).toBe(1);
  });

  test("no error-free results → rate is null, never a divide-by-zero", () => {
    expect(ownedCitationReach([]).rate).toBeNull();
    expect(
      ownedCitationReach([{ hasError: true, ownedCited: true }]).rate,
    ).toBeNull();
  });
});

describe("ownedCitationByRun — reach trend over run dates", () => {
  test("groups by run, computes each run's reach, sorted ascending by date", () => {
    const trend = ownedCitationByRun([
      { runDate: "2026-04-15", hasError: false, ownedCited: true },
      { runDate: "2026-03-30", hasError: false, ownedCited: true },
      { runDate: "2026-03-30", hasError: false, ownedCited: false },
      { runDate: "2026-04-15", hasError: false, ownedCited: false },
      { runDate: "2026-04-15", hasError: false, ownedCited: false },
    ]);
    expect(trend.map((p) => p.runDate)).toEqual(["2026-03-30", "2026-04-15"]);
    expect(trend[0]?.reach).toEqual({ all: 2, cited: 1, rate: 0.5 });
    expect(trend[1]?.reach).toEqual({ all: 3, cited: 1, rate: 1 / 3 });
  });
});

describe("ownedUrlsByFrequency — which owned URLs appear, with citing results", () => {
  test("ranks URLs by distinct citing-result count, then URL; carries the results", () => {
    const agg = ownedUrlsByFrequency([
      { url: "https://taskwell.app/a", resultId: "r1", provider: "openai" },
      { url: "https://taskwell.app/a", resultId: "r2", provider: "anthropic" },
      { url: "https://taskwell.app/b", resultId: "r3", provider: "openai" },
    ]);
    expect(agg.map((u) => [u.url, u.resultCount])).toEqual([
      ["https://taskwell.app/a", 2],
      ["https://taskwell.app/b", 1],
    ]);
    // Citing results are linkable and sorted by provider then result id.
    expect(agg[0]?.results).toEqual([
      { resultId: "r2", provider: "anthropic" },
      { resultId: "r1", provider: "openai" },
    ]);
  });

  test("a URL repeated within one result counts that result once", () => {
    const agg = ownedUrlsByFrequency([
      { url: "https://taskwell.app/a", resultId: "r1", provider: "openai" },
      { url: "https://taskwell.app/a", resultId: "r1", provider: "openai" },
    ]);
    expect(agg).toHaveLength(1);
    expect(agg[0]?.resultCount).toBe(1);
    expect(agg[0]?.results).toEqual([{ resultId: "r1", provider: "openai" }]);
  });
});

// ── Prompt trajectory (issue #13) ─────────────────────────────────────────────

describe("promptTrajectoryByProvider — a line per provider, gaps for absent runs", () => {
  const cell = (over: Partial<PromptTrajectoryRow>): PromptTrajectoryRow => ({
    runDate: "2026-01-01",
    provider: "openai",
    resultId: "r",
    hasError: false,
    mentioned: true,
    accuracyScore: 4,
    ownedCited: false,
    brandRank: "not_ranked",
    ...over,
  });

  test("aligns each provider's cells to runOrder; an absent run is null (a gap), not a zero", () => {
    const runOrder = ["2026-01-01", "2026-01-08", "2026-01-15"];
    const traj = promptTrajectoryByProvider(
      [
        cell({ provider: "openai", runDate: "2026-01-01", resultId: "a" }),
        // openai is absent from 2026-01-08 (the gap), present again on 01-15
        cell({ provider: "openai", runDate: "2026-01-15", resultId: "b" }),
        cell({ provider: "anthropic", runDate: "2026-01-08", resultId: "c" }),
      ],
      runOrder,
    );
    // Sorted by provider name.
    expect(traj.map((t) => t.provider)).toEqual(["anthropic", "openai"]);

    const openai = traj.find((t) => t.provider === "openai");
    expect(openai?.cells.map((c) => c?.resultId ?? null)).toEqual([
      "a",
      null, // ← gap, not a zero
      "b",
    ]);

    const anthropic = traj.find((t) => t.provider === "anthropic");
    expect(anthropic?.cells.map((c) => c?.resultId ?? null)).toEqual([
      null,
      "c",
      null,
    ]);
  });

  test("a row whose run isn't on the axis is dropped (defensive)", () => {
    const traj = promptTrajectoryByProvider(
      [cell({ runDate: "1999-12-31" })],
      ["2026-01-01"],
    );
    // The only row is off-axis, so it's skipped before its provider is recorded —
    // no provider entry is created at all.
    expect(traj).toEqual([]);
  });

  test("carries every verdict signal through to the cell for the chosen metric/link", () => {
    const traj = promptTrajectoryByProvider(
      [
        cell({
          resultId: "x",
          hasError: false,
          mentioned: true,
          accuracyScore: 5,
          ownedCited: true,
          brandRank: "1",
        }),
      ],
      ["2026-01-01"],
    );
    expect(traj[0]?.cells[0]).toEqual({
      runDate: "2026-01-01",
      resultId: "x",
      hasError: false,
      mentioned: true,
      accuracyScore: 5,
      ownedCited: true,
      brandRank: "1",
    });
  });
});

describe("promptSparklines — mention rate per run, errors excluded, gaps preserved", () => {
  const m = (over: Partial<PromptMentionRow>): PromptMentionRow => ({
    promptId: "p1",
    runDate: "2026-01-01",
    hasError: false,
    mentioned: false,
    ...over,
  });

  test("pools providers into a mention rate per run; errored results leave neither numerator nor denominator", () => {
    const runOrder = ["2026-01-01", "2026-01-08"];
    const [spark] = promptSparklines(
      [
        // run 1: 2 of 3 error-free mentioned; a 4th result errored (excluded).
        m({ runDate: "2026-01-01", mentioned: true }),
        m({ runDate: "2026-01-01", mentioned: true }),
        m({ runDate: "2026-01-01", mentioned: false }),
        m({ runDate: "2026-01-01", mentioned: true, hasError: true }),
        // run 2: 0 of 2 mentioned.
        m({ runDate: "2026-01-08", mentioned: false }),
        m({ runDate: "2026-01-08", mentioned: false }),
      ],
      runOrder,
    );
    expect(spark?.mentionRate).toEqual([2 / 3, 0]);
    expect(spark?.latestRate).toBe(0);
    expect(spark?.present).toBe(5); // error-free results across both runs
  });

  test("a run with no error-free result is a null gap (not a zero); latestRate skips the gap", () => {
    const runOrder = ["2026-01-01", "2026-01-08", "2026-01-15"];
    const [spark] = promptSparklines(
      [
        m({ runDate: "2026-01-01", mentioned: true }),
        // 2026-01-08: only an errored result → no error-free denominator → gap.
        m({ runDate: "2026-01-08", mentioned: true, hasError: true }),
        // 2026-01-15: absent entirely → gap.
      ],
      runOrder,
    );
    expect(spark?.mentionRate).toEqual([1, null, null]);
    // latestRate is the most recent *non-null* point, skipping the trailing gaps.
    expect(spark?.latestRate).toBe(1);
  });

  test("a prompt never present anywhere reports a null latestRate", () => {
    const [spark] = promptSparklines(
      [m({ runDate: "2026-01-08", hasError: true })],
      ["2026-01-01", "2026-01-08"],
    );
    expect(spark?.mentionRate).toEqual([null, null]);
    expect(spark?.latestRate).toBeNull();
    expect(spark?.present).toBe(0);
  });
});
