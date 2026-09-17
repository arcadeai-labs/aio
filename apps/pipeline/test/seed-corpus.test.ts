// Property tests for the shipped fifteen-week corpus.
//
// These run against the corpus `bun run seed` actually produces — the shipped
// `prompts/default.csv` and `analytics.config.example.json`, the default seed,
// the default anchor date — because the acceptance criteria are claims about
// *that* corpus, not about a convenient fixture.
//
// **No test here asserts a specific generated number.** A test that pinned
// "week 9's mention rate is 36.5%" would break on every tuning change while
// proving nothing: the number is an output, not a requirement. What is asserted
// is the property each number has to satisfy — branded far exceeds unbranded,
// the funnel narrows, accuracy recovers, the riser crosses us, exactly one
// provider-week errors. Where a threshold appears it comes from the issue's own
// statement of the world (≈90% branded against ≈8% unbranded, ≈2.5/5 early
// against ≈4.5/5 late), stated loosely enough that only a real regression trips
// it.
//
// The cohort arithmetic below mirrors `packages/db/src/metrics.ts` — errored
// results are excluded from every cohort and every denominator, never counted
// as zeros. It is restated here rather than imported because `@aio/pipeline`
// does not depend on `@aio/db` and should not start: this is an assertion about
// the corpus, not a test of the metrics layer.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ResultVerdict, UnifiedResult } from "@aio/core";
import { loadAnalyticsConfig } from "../src/analytics/config.js";
import { loadPrompts } from "../src/load.js";
import { createRng } from "../src/seed/rng.js";
import {
  type SeededCorpus,
  type SeededRun,
  type WorldSpec,
  buildCorpus,
} from "../src/seed/scenario.js";
import { estimatedCostUsd } from "../src/seed/world.js";
import { DEFAULT_TARGETS } from "../src/targets.js";

const ROOT = resolve(import.meta.dir, "../../..");
const WEEKS = 15;
const SEED = "aio-tracer";
const ANCHOR = "2026-09-14";

const config = await loadAnalyticsConfig(
  resolve(ROOT, "analytics.config.example.json"),
);
const prompts = await loadPrompts(resolve(ROOT, "prompts/default.csv"));

const SPEC: WorldSpec = {
  brand: config.brand,
  prompts,
  targets: DEFAULT_TARGETS,
  anchorDate: ANCHOR,
  weeks: WEEKS,
  judgeModel: config.judgeModel,
};

function build(seed = SEED, spec: WorldSpec = SPEC): SeededCorpus {
  return buildCorpus(spec, createRng(seed));
}

const corpus = build();
const BRAND = config.brand.name;
const COMPETITORS = config.brand.knownCompetitors;
/** `world.ts` hands the overtake to the third competitor in the config. */
const RISER = COMPETITORS[2];

// ── Cohort arithmetic (mirrors packages/db/src/metrics.ts) ──────────────────

interface Cohorts {
  all: number;
  mentioned: number;
  competitive: number;
  cited: number;
  firstPlace: number;
  accuracySum: number;
  accuracyCount: number;
}

/** Verdicts paired with their results, errored rows already dropped. */
function judged(
  run: SeededRun,
): { result: UnifiedResult; verdict: ResultVerdict }[] {
  const byId = new Map(run.results.map((r) => [r.id, r]));
  return run.verdicts.flatMap((verdict) => {
    const result = byId.get(verdict.resultId);
    return result && result.error === null ? [{ result, verdict }] : [];
  });
}

function cohorts(
  rows: { result: UnifiedResult; verdict: ResultVerdict }[],
): Cohorts {
  const c: Cohorts = {
    all: 0,
    mentioned: 0,
    competitive: 0,
    cited: 0,
    firstPlace: 0,
    accuracySum: 0,
    accuracyCount: 0,
  };
  for (const { verdict: v } of rows) {
    c.all += 1;
    if (v.brandMention.mentioned) {
      c.mentioned += 1;
      if (v.descriptionAccuracy) {
        c.accuracySum += v.descriptionAccuracy.score;
        c.accuracyCount += 1;
      }
    }
    if (v.competitivePosition.othersPresent) {
      c.competitive += 1;
      if (v.competitivePosition.brandRank === 1) c.firstPlace += 1;
    }
    if (v.ownedCitation.cited) c.cited += 1;
  }
  return c;
}

const segmentOf = (result: UnifiedResult): string =>
  (result.promptMeta?.brandedType ?? "").toLowerCase();

const rate = (numerator: number, denominator: number): number =>
  denominator === 0 ? 0 : numerator / denominator;

const runRows = corpus.runs.map(judged);
const runCohorts = runRows.map(cohorts);

/** Mean of a metric over a slice of the series — used for third-vs-third comparisons. */
function meanOver(
  from: number,
  to: number,
  pick: (c: Cohorts) => number,
): number {
  const slice = runCohorts.slice(from, to).map(pick).filter(Number.isFinite);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

const THIRD = Math.floor(WEEKS / 3);

// ── Determinism ─────────────────────────────────────────────────────────────

describe("determinism", () => {
  test("the same seed produces a byte-identical corpus", () => {
    // Byte-identical, not deep-equal: the corpus is written to disk as JSON and
    // `bun run seed` promises the same bytes on a re-run.
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });

  test("a different seed produces a different corpus", () => {
    const a = JSON.stringify(build(SEED));
    const b = JSON.stringify(build("a-different-world"));
    expect(a).not.toBe(b);
    // Not merely different somewhere: a seed that only perturbed ids would look
    // like sensitivity while leaving the world identical.
    expect(build("a-different-world").runs[0].results[0].responseText).not.toBe(
      corpus.runs[0].results[0].responseText,
    );
  });

  test("ids are unique across the whole corpus", () => {
    const ids = corpus.runs.flatMap((r) => r.results.map((x) => x.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── Structural completeness ─────────────────────────────────────────────────

describe("structural completeness", () => {
  const key = (prompt: string, provider: string, model: string) =>
    [prompt, provider, model].join(" :: ");

  test("fifteen runs, oldest first, exactly seven days apart", () => {
    expect(corpus.runs.length).toBe(WEEKS);
    const dates = corpus.runs.map((r) => r.runDate);
    expect(dates.at(-1)).toBe(ANCHOR);
    for (let i = 1; i < dates.length; i++) {
      expect(Date.parse(dates[i]) - Date.parse(dates[i - 1])).toBe(
        7 * 86_400_000,
      );
    }
  });

  test("every run is the full prompt × provider cross-product, with no gaps or duplicates", () => {
    const expected = prompts.length * DEFAULT_TARGETS.length;
    for (const run of corpus.runs) {
      expect(run.results.length).toBe(expected);
      const keys = run.results.map((r) =>
        key(r.prompt, r.metadata.provider, r.metadata.model),
      );
      expect(new Set(keys).size).toBe(expected);
    }
  });

  test("every week carries the identical join key set", () => {
    // Week-over-week matching joins on (prompt, provider, model). A drift in any
    // of the three ends the old series silently and starts a new one, which
    // reads as a gap in the trend rather than as a bug.
    const weeks = corpus.runs.map((run) =>
      run.results
        .map((r) => key(r.prompt, r.metadata.provider, r.metadata.model))
        .sort(),
    );
    for (const week of weeks.slice(1)) expect(week).toEqual(weeks[0]);
  });

  test("prompt text is byte-identical across all fifteen weeks", () => {
    const perWeek = corpus.runs.map((run) =>
      [...new Set(run.results.map((r) => r.prompt))].sort(),
    );
    const source = prompts.map((p) => p.prompt).sort();
    for (const week of perWeek) expect(week).toEqual(source);
  });

  test("every non-errored result is judged exactly once, and no errored one is", () => {
    for (const run of corpus.runs) {
      const judgedIds = run.verdicts.map((v) => v.resultId);
      expect(new Set(judgedIds).size).toBe(judgedIds.length);
      const ids = new Set(judgedIds);
      for (const r of run.results) expect(ids.has(r.id)).toBe(r.error === null);
    }
  });
});

// ── 1. The branded / unbranded gap ──────────────────────────────────────────

describe("the branded/unbranded gap", () => {
  const pooled = (segment: string) =>
    cohorts(
      runRows.flat().filter(({ result }) => segmentOf(result) === segment),
    );

  test("the brand actually matched something — with excerpts, not just counts", () => {
    // A corpus where nothing matched renders a clean, believable 0% that is
    // indistinguishable from a brand nobody mentions. Counting is not evidence;
    // quoting is.
    const excerpts = runRows
      .flat()
      .flatMap(({ verdict }) => verdict.brandMention.excerpts);
    expect(excerpts.length).toBeGreaterThan(100);
    for (const excerpt of excerpts.slice(0, 200)) {
      expect(excerpt).toContain(BRAND);
    }
  });

  test("branded mention rate is high and unbranded is low, pooled over the series", () => {
    const branded = pooled("branded");
    const unbranded = pooled("unbranded");
    expect(branded.all).toBeGreaterThan(0);
    expect(unbranded.all).toBeGreaterThan(0);
    // The issue's world: ≈90% branded against ≈8% unbranded. Asserted loosely,
    // so tuning moves freely and a collapse still trips it.
    expect(rate(branded.mentioned, branded.all)).toBeGreaterThan(0.75);
    expect(rate(unbranded.mentioned, unbranded.all)).toBeLessThan(0.25);
  });

  test("the gap holds in every single run, not just on average", () => {
    for (const [i, rows] of runRows.entries()) {
      const branded = cohorts(
        rows.filter((r) => segmentOf(r.result) === "branded"),
      );
      const unbranded = cohorts(
        rows.filter((r) => segmentOf(r.result) === "unbranded"),
      );
      const gap =
        rate(branded.mentioned, branded.all) -
        rate(unbranded.mentioned, unbranded.all);
      expect({ week: i, wide: gap > 0.4 }).toEqual({ week: i, wide: true });
    }
  });
});

// ── 2. The accuracy recovery ────────────────────────────────────────────────

describe("the description-accuracy recovery", () => {
  const meanAccuracy = (c: Cohorts) => c.accuracySum / c.accuracyCount;

  test("accuracy is scored only where the brand was described", () => {
    for (const { verdict: v } of runRows.flat()) {
      if (v.brandMention.mentioned) {
        expect(v.descriptionAccuracy).not.toBeNull();
        expect([1, 2, 3, 4, 5]).toContain(v.descriptionAccuracy?.score);
      } else {
        expect(v.descriptionAccuracy).toBeNull();
      }
    }
  });

  test("the last third scores materially better than the first third", () => {
    const early = meanOver(0, THIRD, meanAccuracy);
    const late = meanOver(WEEKS - THIRD, WEEKS, meanAccuracy);
    expect(early).toBeLessThan(3);
    expect(late).toBeGreaterThan(4);
    expect(late - early).toBeGreaterThan(1);
  });

  test("the recovery happens across the middle, not as a step at one end", () => {
    // The corpus models a quarter because the underlying phenomenon moves on
    // that timescale. A jump between two adjacent weeks would draw a cliff, and
    // teach a reader to expect feedback they will never get.
    const meanAccuracy = (c: Cohorts) => c.accuracySum / c.accuracyCount;
    const middle = meanOver(THIRD, WEEKS - THIRD, meanAccuracy);
    const early = meanOver(0, THIRD, meanAccuracy);
    const late = meanOver(WEEKS - THIRD, WEEKS, meanAccuracy);
    expect(middle).toBeGreaterThan(early);
    expect(middle).toBeLessThan(late);
  });
});

// ── 3. The competitor overtake ──────────────────────────────────────────────

describe("the competitor overtake", () => {
  /** Share of the competitive cohort, the denominator `metrics.ts` uses. */
  const shares = (rows: { verdict: ResultVerdict }[]) => {
    const competitive = rows.filter(
      (r) => r.verdict.competitivePosition.othersPresent,
    );
    const share = (name: string) =>
      rate(
        competitive.filter((r) =>
          r.verdict.competitivePosition.competitors.some(
            (c) => c.mentioned && c.name === name,
          ),
        ).length,
        competitive.length,
      );
    return {
      brand: rate(
        competitive.filter((r) => r.verdict.brandMention.mentioned).length,
        competitive.length,
      ),
      riser: share(RISER),
    };
  };

  const series = runRows.map(shares);

  test("the riser starts behind the brand and ends ahead of it", () => {
    expect(series[0].riser).toBeLessThan(series[0].brand);
    expect(series.at(-1)?.riser).toBeGreaterThan(series.at(-1)?.brand ?? 1);
  });

  test("the crossover is a sustained overtake, not a one-week wobble", () => {
    for (const [i, week] of series.entries()) {
      if (i < THIRD)
        expect({ i, ahead: week.riser > week.brand }).toEqual({
          i,
          ahead: false,
        });
      if (i >= WEEKS - THIRD)
        expect({ i, ahead: week.riser > week.brand }).toEqual({
          i,
          ahead: true,
        });
    }
  });

  test("the riser gains ground while the brand's own share holds", () => {
    // The story is the competitor climbing, not the brand collapsing: if both
    // moved, a reader could not tell which one the chart is about.
    const early = series.slice(0, THIRD);
    const late = series.slice(WEEKS - THIRD);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(
      mean(late.map((s) => s.riser)) - mean(early.map((s) => s.riser)),
    ).toBeGreaterThan(0.25);
    expect(
      Math.abs(
        mean(late.map((s) => s.brand)) - mean(early.map((s) => s.brand)),
      ),
    ).toBeLessThan(0.15);
  });

  test("a brand that was not mentioned is never ranked", () => {
    for (const { verdict: v } of runRows.flat()) {
      if (!v.brandMention.mentioned) {
        expect(v.competitivePosition.brandRank).toBe("not_ranked");
      }
    }
  });

  test("othersPresent and othersCount agree with the competitor list", () => {
    for (const { verdict: v } of runRows.flat()) {
      const named = v.competitivePosition.competitors.filter(
        (c) => c.mentioned,
      );
      expect(v.competitivePosition.othersCount).toBe(named.length);
      expect(v.competitivePosition.othersPresent).toBe(named.length > 0);
    }
  });
});

// ── 4. The one-week provider outage ─────────────────────────────────────────

describe("the one-week provider outage", () => {
  const erroredCells = corpus.runs.flatMap((run, week) =>
    run.results
      .filter((r) => r.error !== null)
      .map((r) => ({
        week,
        runDate: run.runDate,
        provider: r.metadata.provider,
      })),
  );

  test("exactly one (provider, week) pair carries errors", () => {
    const pairs = new Set(
      erroredCells.map((c) => `${c.runDate}::${c.provider}`),
    );
    expect(pairs.size).toBe(1);
    expect(erroredCells.length).toBe(prompts.length);
  });

  test("an errored result carries an error code and no answer", () => {
    for (const run of corpus.runs) {
      for (const r of run.results.filter((x) => x.error !== null)) {
        expect(r.error?.code).toMatch(/^HTTP_\d{3}$/);
        expect(r.responseText).toBe("");
        expect(r.citations).toEqual([]);
        expect(r.searchResults).toEqual([]);
      }
    }
  });

  test("errored results appear in no cohort and no denominator", () => {
    const { runDate, provider } = erroredCells[0];
    const week = corpus.runs.findIndex((r) => r.runDate === runDate);
    const forProvider = (i: number) =>
      cohorts(
        runRows[i].filter((r) => r.result.metadata.provider === provider),
      );

    // Not "counted as zeros": the provider has no denominator at all that week,
    // which is what stops a provider outage reading as a brand decline.
    expect(forProvider(week).all).toBe(0);
    expect(forProvider(week).mentioned).toBe(0);
    for (const adjacent of [week - 1, week + 1].filter(
      (i) => i >= 0 && i < WEEKS,
    )) {
      expect(forProvider(adjacent).all).toBe(prompts.length);
    }
  });

  test("the outage dents the run's population but not the pooled rate", () => {
    const week = corpus.runs.findIndex(
      (r) => r.runDate === erroredCells[0].runDate,
    );
    const full = prompts.length * DEFAULT_TARGETS.length;
    expect(runCohorts[week].all).toBe(full - prompts.length);
    // Every other week is complete — the outage is the only gap in the corpus.
    for (const [i, c] of runCohorts.entries()) {
      if (i !== week) expect(c.all).toBe(full);
    }
  });
});

// ── 5. The cohort funnel ────────────────────────────────────────────────────

describe("the cohort funnel", () => {
  test("cited ≤ mentioned ≤ counted, in every run", () => {
    for (const [i, c] of runCohorts.entries()) {
      expect({ week: i, ok: c.cited <= c.mentioned }).toEqual({
        week: i,
        ok: true,
      });
      expect({ week: i, ok: c.mentioned <= c.all }).toEqual({
        week: i,
        ok: true,
      });
    }
  });

  test("the funnel visibly narrows rather than repeating one denominator", () => {
    for (const [i, c] of runCohorts.entries()) {
      expect({
        week: i,
        narrows: c.cited < c.mentioned && c.mentioned < c.all,
      }).toEqual({
        week: i,
        narrows: true,
      });
    }
  });

  test("only a mentioned brand can own a citation, and the URL is in the result", () => {
    let cited = 0;
    for (const { result, verdict: v } of runRows.flat()) {
      expect(v.ownedCitation.cited).toBe(v.ownedCitation.urls.length > 0);
      if (!v.ownedCitation.cited) continue;
      cited++;
      expect(v.brandMention.mentioned).toBe(true);
      const urls = new Set(result.citations.map((c) => c.url));
      for (const url of v.ownedCitation.urls) {
        expect(urls.has(url)).toBe(true);
        expect(config.brand.ownedDomains.some((d) => url.includes(d))).toBe(
          true,
        );
      }
    }
    expect(cited).toBeGreaterThan(0);
  });

  test("every citation URL is one the result actually surfaced", () => {
    for (const run of corpus.runs) {
      for (const r of run.results) {
        const surfaced = new Set(r.searchResults.map((s) => s.url));
        for (const c of r.citations) expect(surfaced.has(c.url)).toBe(true);
      }
    }
  });
});

// ── 6. Divergence, and a quantity that ends worse ───────────────────────────

describe("divergence between providers", () => {
  const perProvider = DEFAULT_TARGETS.map((target) => {
    const rows = runRows
      .flat()
      .filter((r) => r.result.metadata.provider === target.provider);
    const c = cohorts(rows);
    return {
      provider: target.provider,
      mentionRate: rate(c.mentioned, c.all),
      accuracy: c.accuracySum / c.accuracyCount,
      citationRate: rate(c.cited, c.all),
    };
  });

  test("the per-provider breakdown is not six near-identical rows", () => {
    const spread = (pick: (p: (typeof perProvider)[number]) => number) =>
      Math.max(...perProvider.map(pick)) - Math.min(...perProvider.map(pick));
    expect(spread((p) => p.mentionRate)).toBeGreaterThan(0.05);
    expect(spread((p) => p.accuracy)).toBeGreaterThan(0.4);
    expect(spread((p) => p.citationRate)).toBeGreaterThan(0.05);
  });

  test("a provider's standing is not one number wearing three hats", () => {
    // If mention rate ranked the providers the same way accuracy did, the
    // breakdown would carry one fact in three columns and a reader could stop
    // reading after the first.
    const order = (pick: (p: (typeof perProvider)[number]) => number) =>
      [...perProvider].sort((a, b) => pick(b) - pick(a)).map((p) => p.provider);
    expect(order((p) => p.mentionRate)).not.toEqual(order((p) => p.accuracy));
  });
});

describe("not every metric improves", () => {
  test("the 1st-place rate ends the series well below where it started", () => {
    // The named decline. A world where everything rises never exercises the
    // interface's handling of a loss, which is the case a reader most needs to
    // be able to read.
    const firstPlaceRate = (c: Cohorts) => rate(c.firstPlace, c.competitive);
    const early = meanOver(0, THIRD, firstPlaceRate);
    const late = meanOver(WEEKS - THIRD, WEEKS, firstPlaceRate);
    expect(late).toBeLessThan(early / 2);
    expect(early).toBeGreaterThan(0.1);
  });

  test("week-over-week movement goes in both directions somewhere in the series", () => {
    const mentionRate = runCohorts.map((c) => rate(c.mentioned, c.all));
    const deltas = mentionRate.slice(1).map((v, i) => v - mentionRate[i]);
    expect(deltas.some((d) => d > 0)).toBe(true);
    expect(deltas.some((d) => d < 0)).toBe(true);
  });
});

// ── 7. Every documented optional field, both ways ───────────────────────────
//
// SCHEMA.md documents six optional fields the corpus never produced, so the
// document could only be checked against them by a credentialed run (#34).
// Two claims are asserted here and neither is a count:
//
//   **Both paths.** Each optional field is populated somewhere and absent
//   somewhere. An optional field that is always present is not being exercised
//   as optional, and the bug that catches is a query dropping rows because a
//   field is missing.
//
//   **Fidelity.** It is populated by exactly the providers that populate it in
//   `src/providers/*.ts`. A field seeded onto every row would agree with the
//   contract and disagree with the pipeline, and a query calibrated against it
//   would come back wrong on real data.
//
// The absences are asserted under a *second* seed as well. They are positional
// rather than sampled precisely so they cannot evaporate under `SEED=…`, and a
// test that only ever looked at one seed could not tell the difference.

describe("the optional fields are exercised both ways", () => {
  const allResults = corpus.runs.flatMap((r) => r.results);
  const allSources = allResults.flatMap((r) => r.searchResults);
  const allCitations = allResults.flatMap((r) => r.citations);

  /** Present-and-absent, stated once so every field reads the same way. */
  const bothWays = (
    field: string,
    population: number,
    present: number,
  ): void => {
    expect({
      field,
      present: present > 0,
      absent: present < population,
    }).toEqual({ field, present: true, absent: true });
  };

  test("RunMetadata.estimatedCostUsd — present and absent", () => {
    bothWays(
      "estimatedCostUsd",
      allResults.length,
      allResults.filter((r) => r.metadata.estimatedCostUsd !== undefined)
        .length,
    );
  });

  test("SearchResult.pageDate and SearchResult.score — present and absent", () => {
    bothWays(
      "pageDate",
      allSources.length,
      allSources.filter((s) => s.pageDate !== undefined).length,
    );
    bothWays(
      "score",
      allSources.length,
      allSources.filter((s) => s.score !== undefined).length,
    );
  });

  test("Citation.startIndex / endIndex — present and absent", () => {
    bothWays(
      "startIndex",
      allCitations.length,
      allCitations.filter((c) => c.startIndex !== undefined).length,
    );
    bothWays(
      "endIndex",
      allCitations.length,
      allCitations.filter((c) => c.endIndex !== undefined).length,
    );
  });

  test("UnifiedResult.promptCategory, promptMeta and rawSearchCalls — present and absent", () => {
    bothWays(
      "promptCategory",
      allResults.length,
      allResults.filter((r) => r.promptCategory !== undefined).length,
    );
    bothWays(
      "promptMeta",
      allResults.length,
      allResults.filter((r) => r.promptMeta !== undefined).length,
    );
    bothWays(
      "rawSearchCalls",
      allResults.length,
      allResults.filter((r) => r.rawSearchCalls !== undefined).length,
    );
    bothWays(
      "providerMeta",
      allResults.length,
      allResults.filter((r) => r.metadata.providerMeta !== undefined).length,
    );
  });

  test("promptMeta.location and promptMeta.labels — present and absent", () => {
    const metas = [...new Map(allResults.map((r) => [r.prompt, r.promptMeta]))];
    expect(metas.length).toBe(prompts.length);
    bothWays(
      "promptMeta.location",
      metas.length,
      metas.filter(([, m]) => m?.location !== undefined).length,
    );
    bothWays(
      "promptMeta.labels",
      metas.length,
      metas.filter(([, m]) => m?.labels !== undefined).length,
    );
  });

  test("a labels string repeats a label, so the de-dup at ingest has something to do", () => {
    // `parseLabels` (packages/ingest/src/normalize.ts) splits on `,`, trims and
    // de-dupes through a `Set`. Without a repeat anywhere in the corpus that
    // arm is exercised by nothing, and a rewrite that dropped it would ingest
    // cleanly and lose nothing visible.
    const labelStrings = [
      ...new Set(
        allResults.flatMap((r) =>
          r.promptMeta?.labels ? [r.promptMeta.labels] : [],
        ),
      ),
    ];
    const withRepeat = labelStrings.filter((raw) => {
      const parts = raw.split(",").map((p) => p.trim());
      return parts.length > new Set(parts).size;
    });
    expect(withRepeat.length).toBeGreaterThan(0);
    // And the ordinary case is still the majority — a corpus made entirely of
    // the odd case would not be a realistic subset.
    expect(labelStrings.length - withRepeat.length).toBeGreaterThan(
      withRepeat.length,
    );
  });

  test("the absences survive a different seed — they are structural, not sampled", () => {
    const other = build("a-different-world");
    const results = other.runs.flatMap((r) => r.results);
    const sources = results.flatMap((r) => r.searchResults);
    const citations = results.flatMap((r) => r.citations);
    const metas = [...new Map(results.map((r) => [r.prompt, r.promptMeta]))];

    expect({
      promptMeta: results.some((r) => r.promptMeta === undefined),
      promptCategory: results.some((r) => r.promptCategory === undefined),
      labels: metas.some(([, m]) => m !== undefined && m.labels === undefined),
      location: metas.some(
        ([, m]) => m !== undefined && m.location === undefined,
      ),
      cost: results.some((r) => r.metadata.estimatedCostUsd === undefined),
      score: sources.some((s) => s.score === undefined),
      pageDate: sources.some((s) => s.pageDate === undefined),
      offsets: citations.some((c) => c.startIndex === undefined),
    }).toEqual({
      promptMeta: true,
      promptCategory: true,
      labels: true,
      location: true,
      cost: true,
      score: true,
      pageDate: true,
      offsets: true,
    });
  });
});

describe("the optional fields agree with the providers that write them", () => {
  const rowsOf = (provider: string) =>
    corpus.runs
      .flatMap((r) => r.results)
      .filter((r) => r.metadata.provider === provider && r.error === null);

  // Each pair is (field, the providers that populate it in src/providers/*.ts).
  // Nothing outside the named set may carry the field, and every provider
  // inside it must carry it somewhere — a one-sided check would pass over a
  // corpus that simply stopped producing the field.
  test("estimatedCostUsd is written by anthropic-agent and by nobody else", () => {
    for (const target of DEFAULT_TARGETS) {
      const populated = rowsOf(target.provider).filter(
        (r) => r.metadata.estimatedCostUsd !== undefined,
      ).length;
      expect({
        provider: target.provider,
        populated: populated > 0,
      }).toEqual({
        provider: target.provider,
        populated: target.provider === "anthropic-agent",
      });
    }
  });

  test("pageDate is written by anthropic and exa, and score only by exa", () => {
    for (const target of DEFAULT_TARGETS) {
      const sources = rowsOf(target.provider).flatMap((r) => r.searchResults);
      expect({
        provider: target.provider,
        dated: sources.some((s) => s.pageDate !== undefined),
        scored: sources.some((s) => s.score !== undefined),
      }).toEqual({
        provider: target.provider,
        dated: ["anthropic", "exa"].includes(target.provider),
        scored: target.provider === "exa",
      });
    }
  });

  test("citation offsets are written by openai and openrouter, and by nobody else", () => {
    for (const target of DEFAULT_TARGETS) {
      const citations = rowsOf(target.provider).flatMap((r) => r.citations);
      expect({
        provider: target.provider,
        offset: citations.some((c) => c.startIndex !== undefined),
      }).toEqual({
        provider: target.provider,
        offset: ["openai", "openrouter"].includes(target.provider),
      });
    }
  });

  test("every citation offset resolves to the text it claims to quote", () => {
    // The check a reviewer runs first, and the one the field is worthless
    // without: `citedText` is what `providers/openai.ts` and
    // `providers/openrouter.ts` slice out of `responseText` at exactly these
    // offsets. An offset into nothing would populate the column, satisfy the
    // contract, and point at a passage that does not exist.
    let checked = 0;
    for (const result of corpus.runs.flatMap((r) => r.results)) {
      for (const c of result.citations) {
        if (c.startIndex === undefined) continue;
        expect({
          id: result.id,
          resolved: result.responseText.slice(c.startIndex, c.endIndex),
        }).toEqual({ id: result.id, resolved: c.citedText });
        expect(c.citedText.length).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("a page is never published after the run that found it", () => {
    for (const run of corpus.runs) {
      for (const source of run.results.flatMap((r) => r.searchResults)) {
        if (!source.pageDate) continue;
        expect({
          run: run.runDate,
          published: source.pageDate.slice(0, 10) <= run.runDate,
        }).toEqual({ run: run.runDate, published: true });
      }
    }
  });

  test("a reported cost agrees with the token counts printed beside it", () => {
    // The result page renders tokens and cost together. A cost drawn
    // independently of the tokens would be a number nobody can falsify by
    // looking — this corpus's signature failure in miniature.
    const priced = corpus.runs
      .flatMap((r) => r.results)
      .filter((r) => r.metadata.estimatedCostUsd !== undefined);
    expect(priced.length).toBeGreaterThan(0);
    for (const r of priced) {
      const usage = r.metadata.tokenUsage;
      expect({
        id: r.id,
        cost: estimatedCostUsd({
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          searchRequests: usage.searchRequests ?? 0,
        }),
      }).toEqual({ id: r.id, cost: r.metadata.estimatedCostUsd as number });
      expect(r.metadata.estimatedCostUsd).toBeGreaterThan(0);
    }
  });
});
