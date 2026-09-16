// Metrics layer — pure aggregation over result/verdict rows. Kept free of any
// DB import so it stays unit-testable over fixture rows (the SQL-backed callers
// live in `queries.ts` and feed these same functions live rows). Issue #5 needed
// exactly one metric (mention rate); issue #6 completes the headline — all four
// core metrics with their correct cohorts/denominators, the explicit cohort
// funnel that labels every number's population, and per-provider coverage.

/**
 * One result's contribution to the headline cohorts. Shaped so a fixture row and
 * a `results ⟕ verdicts` SELECT are the same thing. Every verdict field is
 * nullable because the join is a LEFT JOIN: a non-errored result with no verdict
 * (a join miss) still counts toward the All cohort N, but contributes to no
 * numerator.
 *   - `hasError`      — from `results.has_error`
 *   - `mentioned`     — `verdicts.mentioned`
 *   - `accuracyScore` — `verdicts.accuracy_score` (1–5; null unless mentioned)
 *   - `ownedCited`    — `verdicts.owned_cited`
 *   - `othersPresent` — `verdicts.others_present` (the competitive cohort flag)
 *   - `brandRank`     — `verdicts.brand_rank` ('1' | '2' | '3' | 'not_ranked')
 */
export interface MetricRow {
  hasError: boolean;
  mentioned: boolean | null;
  accuracyScore: number | null;
  ownedCited: boolean | null;
  othersPresent: boolean | null;
  brandRank: string | null;
}

/** A rate that always carries its numerator and denominator, never a bare %. */
export interface Rate {
  numerator: number;
  /** Cohort population this rate is computed over. */
  denominator: number;
  /** numerator / denominator, or `null` when the denominator is 0. */
  rate: number | null;
}

const ratio = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  rate: denominator === 0 ? null : numerator / denominator,
});

/**
 * Average accuracy over the Mentioned cohort. `count` is the population the mean
 * is averaged over (mentioned results carrying a non-null score) and is always
 * shown alongside the mean so a 5.0-over-1 never reads like a 5.0-over-300.
 */
export interface AvgAccuracy {
  /** Mean `accuracy_score` (1–5), or `null` when count = 0. */
  mean: number | null;
  count: number;
}

/**
 * The always-visible cohort funnel (spec §6) — every metric is anchored to one
 * of these populations so no number floats without its denominator:
 *
 *   All (error IS NULL)
 *     └─ Mentioned (mentioned = true)
 *          └─ Competitive (others_present = true)   ← rank lives here
 *     └─ Cited (owned_cited = true)                 ← parallel high-value cohort
 *
 * Counts are over error-free results only; failed runs never enter the funnel.
 */
export interface CohortFunnel {
  all: number;
  mentioned: number;
  competitive: number;
  cited: number;
}

export interface HeadlineMetrics {
  funnel: CohortFunnel;
  /** count(mentioned) / All. */
  mentionRate: Rate;
  /** mean accuracy over the Mentioned cohort. */
  avgAccuracy: AvgAccuracy;
  /** count(owned_cited) / All. */
  ownedCitationRate: Rate;
  /** count(brand_rank = 1, within Competitive) / Competitive — top pick when others are present. */
  firstPlaceRate: Rate;
}

/**
 * The full headline for a run, pooled across all providers. Errored results are
 * excluded from every cohort and every denominator (a provider flaking must
 * never read as a brand decline); they surface separately via
 * {@link coverageByProvider}. Single pass over the rows.
 */
export function headlineMetrics(rows: Iterable<MetricRow>): HeadlineMetrics {
  let all = 0;
  let mentioned = 0;
  let competitive = 0;
  let cited = 0;
  let firstPlace = 0;
  let accuracySum = 0;
  let accuracyCount = 0;

  for (const row of rows) {
    if (row.hasError) continue; // excluded from all cohorts/denominators
    all += 1;
    if (row.mentioned === true) {
      mentioned += 1;
      // accuracy_score is null unless mentioned; guard anyway so a missing
      // score is dropped from the mean rather than counted as 0.
      if (row.accuracyScore != null) {
        accuracySum += row.accuracyScore;
        accuracyCount += 1;
      }
    }
    if (row.othersPresent === true) {
      competitive += 1;
      // 1st place lives strictly inside the Competitive cohort: a brand_rank of
      // "1" only counts when others were present, so the numerator can never
      // escape its own denominator (rate stays ≤ 1) even if upstream judging
      // emits a rank without competitors.
      if (row.brandRank === "1") firstPlace += 1;
    }
    if (row.ownedCited === true) cited += 1;
  }

  return {
    funnel: { all, mentioned, competitive, cited },
    mentionRate: ratio(mentioned, all),
    avgAccuracy: {
      mean: accuracyCount === 0 ? null : accuracySum / accuracyCount,
      count: accuracyCount,
    },
    ownedCitationRate: ratio(cited, all),
    firstPlaceRate: ratio(firstPlace, competitive),
  };
}

/**
 * Per-provider coverage: how many of a provider's attempted results errored.
 * Reported separately from the headline (which excludes these rows) so a flaking
 * provider is visible as a coverage gap, not hidden in a pooled rate. Sorted by
 * provider name for stable rendering.
 */
export interface ProviderCoverage {
  provider: string;
  attempted: number;
  errored: number;
  /** errored / attempted, or `null` when nothing was attempted. */
  errorRate: number | null;
}

export function coverageByProvider(
  rows: Iterable<{ provider: string; hasError: boolean }>,
): ProviderCoverage[] {
  const byProvider = new Map<string, { attempted: number; errored: number }>();
  for (const row of rows) {
    const acc = byProvider.get(row.provider) ?? { attempted: 0, errored: 0 };
    acc.attempted += 1;
    if (row.hasError) acc.errored += 1;
    byProvider.set(row.provider, acc);
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, { attempted, errored }]) => ({
      provider,
      attempted,
      errored,
      errorRate: attempted === 0 ? null : errored / attempted,
    }));
}

/**
 * The primary scoreboard control (spec §6, PRD story #8). `Global` is every
 * error-free result; `Branded`/`Unbranded` scope to the as-run `branded_type` of
 * the prompt. Segment composes with the theme breakdown below (segment × theme).
 */
export type Segment = "global" | "branded" | "unbranded";

/**
 * A headline row carrying the two as-run classification facts the scoreboard
 * scopes by: `runBrandedType` (the segment axis) and `runTheme` (the orthogonal
 * breakdown axis). Both are nullable — a result can predate classification or
 * miss its verdict join. The plain {@link MetricRow} feeds the pooled headline;
 * a `ScopedRow` is what segment/theme filtering operates over before pooling.
 */
export interface ScopedRow extends MetricRow {
  /** `'branded' | 'unbranded'` (the segment axis), or null. */
  runBrandedType: string | null;
  /** The theme/category (the breakdown axis), or null. */
  runTheme: string | null;
}

/**
 * Scope rows to a segment. `global` passes everything through (the segment axis
 * is a no-op); `branded`/`unbranded` keep only rows whose as-run `branded_type`
 * matches. Pure and generic so it filters coverage rows as readily as metric
 * rows — anything carrying `runBrandedType` — and so the same scoped set feeds
 * both the headline and per-provider coverage.
 */
export function filterBySegment<T extends { runBrandedType: string | null }>(
  rows: Iterable<T>,
  segment: Segment,
): T[] {
  const all = [...rows];
  if (segment === "global") return all;
  return all.filter((r) => r.runBrandedType === segment);
}

/** A full headline for one theme within the current segment (cross-tab cell). */
export interface ThemeMetrics extends HeadlineMetrics {
  /** The theme value, or null for results that carry no theme. */
  theme: string | null;
}

/**
 * Expand a (already segment-scoped) set of rows into one full headline per theme
 * — the segment × theme cross-tab that backs the scoreboard's theme breakdown.
 * Each row reuses {@link headlineMetrics}, so a theme cell and the pooled
 * headline are computed identically. Sorted by theme name with the null-theme
 * bucket last, for stable rendering. Errored rows carry a theme too, but
 * `headlineMetrics` drops them from every cohort just as it does in the pooled
 * headline.
 */
export function metricsByTheme(rows: Iterable<ScopedRow>): ThemeMetrics[] {
  const byTheme = new Map<string | null, ScopedRow[]>();
  for (const row of rows) {
    const key = row.runTheme;
    const bucket = byTheme.get(key);
    if (bucket) bucket.push(row);
    else byTheme.set(key, [row]);
  }
  return [...byTheme.entries()]
    .sort(([a], [b]) => {
      // Null theme sorts last; otherwise alphabetical.
      if (a === null) return b === null ? 0 : 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    })
    .map(([theme, themeRows]) => ({ theme, ...headlineMetrics(themeRows) }));
}

/** A full headline for one provider within the current segment (PRD §7: the
 * cross-provider headline is pooled, and the per-provider breakdown is always one
 * level down). Carries the same metrics as the pooled headline, scoped to one
 * provider's rows. */
export interface ProviderMetrics extends HeadlineMetrics {
  provider: string;
}

/**
 * Expand a (already segment-scoped) set of rows into one full headline per
 * provider — the per-provider breakdown that sits one level under the pooled
 * headline (issue #8). Each provider cell reuses {@link headlineMetrics}, so a
 * per-provider rate and the pooled rate are computed identically over the same
 * error-free cohort (errored rows surface only via {@link coverageByProvider}).
 * Sorted by provider name for stable rendering.
 */
export function metricsByProvider(
  rows: Iterable<MetricRow & { provider: string }>,
): ProviderMetrics[] {
  const byProvider = new Map<string, (MetricRow & { provider: string })[]>();
  for (const row of rows) {
    const bucket = byProvider.get(row.provider);
    if (bucket) bucket.push(row);
    else byProvider.set(row.provider, [row]);
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, providerRows]) => ({
      provider,
      ...headlineMetrics(providerRows),
    }));
}

/**
 * Scope rows to a single theme within the current segment. `null` (or the
 * sentinel passed by callers as "all") is a no-op; a concrete theme keeps only
 * rows whose as-run `run_theme` matches. Pure and generic so it composes with
 * {@link filterBySegment} over the same scoped set (segment × theme), matching
 * how the scoreboard's theme breakdown reads. A `null` *target* never matches the
 * null-theme bucket here — passing null means "every theme"; the caller maps an
 * explicit "uncategorized" choice to a concrete sentinel before this point if it
 * ever needs the null-theme rows in isolation.
 */
export function filterByTheme<T extends { runTheme: string | null }>(
  rows: Iterable<T>,
  theme: string | null,
): T[] {
  const all = [...rows];
  if (theme === null) return all;
  return all.filter((r) => r.runTheme === theme);
}

// ── Competitive landscape (issue #11) ────────────────────────────────────────
//
// The competitive *cohort* is `others_present = true` — the answers where we
// actually compete, the only place a rank is meaningful. Both metrics below take
// the competitive cohort count as their denominator, so every share on the
// Competitive Landscape view is read against the same, explicitly-labeled
// population (PRD story #14, spec §5). Errored rows are excluded just as they are
// from the headline; a competitive row implies a verdict exists, but the guard is
// kept so these functions stay safe over any fixture/SELECT shape.

/** The four brand-rank buckets, in best→worst display order. */
export type BrandRankKey = "1" | "2" | "3" | "not_ranked";
export const BRAND_RANK_KEYS: readonly BrandRankKey[] = [
  "1",
  "2",
  "3",
  "not_ranked",
];

/**
 * Brand-rank distribution over the competitive cohort. `competitive` is the
 * denominator every bucket is a share of; `counts` sums to `competitive`. A row
 * whose `brandRank` is absent/unrecognized falls into `not_ranked` (defensive —
 * `brand_rank` is NOT NULL on a real verdict), so the buckets always reconcile to
 * the denominator. `firstPlaceRate` is the same `count(rank=1)/competitive` the
 * headline reports, surfaced here against its full distribution.
 */
export interface RankDistribution {
  /** Competitive cohort count (`others_present = true`, error-free) — the denominator. */
  competitive: number;
  counts: Record<BrandRankKey, number>;
  /** count(brand_rank = 1) / competitive, or null when the cohort is empty. */
  firstPlaceRate: number | null;
}

/**
 * A row's competitive-cohort inputs: its error flag, the cohort flag, and the
 * rank. A subset of {@link MetricRow}, so a `results ⟕ verdicts` SELECT row feeds
 * this directly.
 */
export interface RankRow {
  hasError: boolean;
  othersPresent: boolean | null;
  brandRank: string | null;
}

export function rankDistribution(rows: Iterable<RankRow>): RankDistribution {
  const counts: Record<BrandRankKey, number> = {
    "1": 0,
    "2": 0,
    "3": 0,
    not_ranked: 0,
  };
  let competitive = 0;
  for (const row of rows) {
    if (row.hasError) continue;
    if (row.othersPresent !== true) continue;
    competitive += 1;
    const key = (BRAND_RANK_KEYS as readonly string[]).includes(
      row.brandRank ?? "",
    )
      ? (row.brandRank as BrandRankKey)
      : "not_ranked";
    counts[key] += 1;
  }
  return {
    competitive,
    counts,
    firstPlaceRate: competitive === 0 ? null : counts["1"] / competitive,
  };
}

/**
 * A competitive result carrying the competitors mentioned in it. `competitors`
 * holds only mentioned=true names (the only rows the ingest stores — see
 * `competitor_mentions`), so a join already satisfies the "filtered to
 * mentioned=true" requirement; names are deduped per row here regardless.
 * `mentioned` is the *brand's* own mention flag on the same row — it makes the
 * brand readable on the competitors' denominator (see {@link brandShareOfVoice}).
 * Nullable because the verdict join is a LEFT JOIN elsewhere; null counts as not
 * mentioned, never as a missing row.
 */
export interface CompetitorRow {
  hasError: boolean;
  othersPresent: boolean | null;
  mentioned: boolean | null;
  competitors: string[];
}

/** One competitor's share of the competitive cohort. */
export interface CompetitorShare {
  competitor: string;
  /** Competitive results that mentioned this competitor. */
  mentions: number;
  /** mentions / competitive, or null when the cohort is empty. */
  share: number | null;
}

/**
 * Per-competitor share-of-voice over the competitive cohort: how often each
 * competitor shows up in the answers where we compete. Denominator is the
 * competitive cohort count (shared with {@link rankDistribution}), so a
 * competitor's share and the brand's first-place rate are read against the same
 * population. Sorted by mentions desc, then name, for a stable leaderboard.
 */
export interface ShareOfVoice {
  /** Competitive cohort count — the denominator for every competitor's share. */
  competitive: number;
  competitors: CompetitorShare[];
}

export function shareOfVoice(rows: Iterable<CompetitorRow>): ShareOfVoice {
  let competitive = 0;
  const mentions = new Map<string, number>();
  for (const row of rows) {
    if (row.hasError) continue;
    if (row.othersPresent !== true) continue;
    competitive += 1;
    // Dedupe within a result so a competitor named twice still counts once.
    for (const name of new Set(row.competitors)) {
      mentions.set(name, (mentions.get(name) ?? 0) + 1);
    }
  }
  const competitors = [...mentions.entries()]
    .map(([competitor, count]) => ({
      competitor,
      mentions: count,
      share: competitive === 0 ? null : count / competitive,
    }))
    .sort((a, b) =>
      b.mentions !== a.mentions
        ? b.mentions - a.mentions
        : a.competitor.localeCompare(b.competitor),
    );
  return { competitive, competitors };
}

/**
 * The *brand's* own share of voice over the competitive cohort — count(mentioned)
 * / competitive, the same denominator every competitor's share uses, so "where do
 * we sit in this list" is answerable by reading down one column.
 *
 * ⚠️ This is **not** the headline mention rate, whose denominator is the All
 * cohort. Restricting to the competitive cohort makes it comparable to a
 * competitor's share and *not* comparable to the headline; callers must label it
 * so the two can't be confused.
 */
export interface BrandShareOfVoice {
  /** Competitive cohort count — identical to {@link ShareOfVoice.competitive}. */
  competitive: number;
  /** Competitive results that mentioned the brand. */
  mentions: number;
  /** mentions / competitive, or null when the cohort is empty. */
  share: number | null;
}

/**
 * Brand share of voice over the competitive cohort. Deliberately a sibling of
 * {@link shareOfVoice} rather than an entry inside it: injecting the brand into
 * `competitors` would corrupt the competitor count (`sovTotal`, the "top N of M"
 * label) and let the display caps spend a competitor slot on us. A row whose
 * `mentioned` is null (no verdict) counts as not mentioned — it still sits in the
 * denominator, exactly as it does for every competitor.
 */
export function brandShareOfVoice(
  rows: Iterable<CompetitorRow>,
): BrandShareOfVoice {
  let competitive = 0;
  let mentions = 0;
  for (const row of rows) {
    if (row.hasError) continue;
    if (row.othersPresent !== true) continue;
    competitive += 1;
    if (row.mentioned === true) mentions += 1;
  }
  return {
    competitive,
    mentions,
    share: competitive === 0 ? null : mentions / competitive,
  };
}

/** A competitive row tagged with the run it belongs to — the trend input. */
export interface CompetitiveRunRow extends RankRow, CompetitorRow {
  runDate: string;
}

/** One run's full competitive picture (rank distribution + share-of-voice, the
 * competitors' and the brand's, all on the one competitive-cohort denominator). */
export interface CompetitivePoint {
  runDate: string;
  rankDistribution: RankDistribution;
  shareOfVoice: ShareOfVoice;
  /** The brand's own share of the same cohort — parallel to `shareOfVoice`, never
   * inside it (see {@link brandShareOfVoice}). */
  brandSov: BrandShareOfVoice;
}

/**
 * Group competitive rows by run and compute each run's distribution + SoV — the
 * trend over run dates (spec §5). Sorted by run date ascending so the series
 * reads left→right as time. Callers scope the input by segment/theme first, so
 * the whole trend respects the active scope.
 */
export function competitiveByRun(
  rows: Iterable<CompetitiveRunRow>,
): CompetitivePoint[] {
  const byRun = new Map<string, CompetitiveRunRow[]>();
  for (const row of rows) {
    const bucket = byRun.get(row.runDate);
    if (bucket) bucket.push(row);
    else byRun.set(row.runDate, [row]);
  }
  return [...byRun.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([runDate, runRows]) => ({
      runDate,
      rankDistribution: rankDistribution(runRows),
      shareOfVoice: shareOfVoice(runRows),
      brandSov: brandShareOfVoice(runRows),
    }));
}

/** One competitor's share-of-voice across every run in the trend. */
export interface CompetitorSeries {
  competitor: string;
  /** Total mentions across all runs — the leaderboard ranking key. */
  total: number;
  /** One entry per run in the trend, in the trend's (ascending) run order. A run
   * where the competitor was never mentioned carries `mentions: 0`. */
  points: { runDate: string; mentions: number; share: number | null }[];
}

/**
 * Pivot per-run SoV into per-competitor series across run dates — the shape a
 * trend table/chart reads (a row/line per competitor, a column/point per run).
 * Every series spans every run in `points` order (a run with no mention of the
 * competitor is an explicit 0, so the columns line up), and the list is sorted by
 * total mentions desc, then name, so the most-present competitors lead.
 */
export function shareOfVoiceTrend(
  points: readonly CompetitivePoint[],
): CompetitorSeries[] {
  const series = new Map<
    string,
    { runDate: string; mentions: number; share: number | null }[]
  >();
  // Seed every competitor seen in any run, then fill each run's value so the
  // per-competitor arrays are dense and aligned with `points`.
  const names = new Set<string>();
  for (const p of points) {
    for (const c of p.shareOfVoice.competitors) names.add(c.competitor);
  }
  for (const name of names) series.set(name, []);
  for (const p of points) {
    const byName = new Map(
      p.shareOfVoice.competitors.map((c) => [c.competitor, c]),
    );
    for (const name of names) {
      const c = byName.get(name);
      series.get(name)!.push({
        runDate: p.runDate,
        mentions: c?.mentions ?? 0,
        share: c ? c.share : p.shareOfVoice.competitive === 0 ? null : 0,
      });
    }
  }
  return [...series.entries()]
    .map(([competitor, pts]) => ({
      competitor,
      total: pts.reduce((sum, p) => sum + p.mentions, 0),
      points: pts,
    }))
    .sort((a, b) =>
      b.total !== a.total
        ? b.total - a.total
        : a.competitor.localeCompare(b.competitor),
    );
}

/** One run's point on the brand's share-of-voice series — the same shape a
 * {@link CompetitorSeries} point carries, so the brand line and a competitor line
 * are plotted by identical code. */
export interface BrandSovPoint {
  runDate: string;
  mentions: number;
  share: number | null;
}

/**
 * The brand's share-of-voice series across the trend's runs — the sibling of
 * {@link shareOfVoiceTrend}, kept separate for the same reason
 * {@link brandShareOfVoice} is: the brand is never a competitor, so it must not
 * enter the competitor ranking or be trimmed by the competitor display cap.
 * Dense over `points` (one entry per run, in the trend's ascending run order).
 */
export function brandShareOfVoiceTrend(
  points: readonly CompetitivePoint[],
): BrandSovPoint[] {
  return points.map((p) => ({
    runDate: p.runDate,
    mentions: p.brandSov.mentions,
    share: p.brandSov.share,
  }));
}

// ── Owned-citation reach (issue #12) ─────────────────────────────────────────
//
// The Cited cohort is `owned_cited = true` — "everywhere we show up". Reach is
// the owned-citation rate per run: count(owned_cited) / All (error-free) — the
// same definition the headline reports (spec §7, N = All), surfaced here as a
// trend over run dates. The per-URL breakdown answers *which* owned URLs appear
// and links each back to the result that cited it. Errored rows are excluded
// from the denominator just as they are from the headline.

/**
 * A row's owned-citation inputs: the error flag and the cohort flag. A subset of
 * {@link MetricRow}, so a `results ⟕ verdicts` SELECT row feeds it directly.
 * `ownedCited` is nullable because the verdict join is a LEFT JOIN — a result
 * with no verdict still counts toward All but never toward Cited.
 */
export interface OwnedCitationRow {
  hasError: boolean;
  ownedCited: boolean | null;
}

/**
 * Owned-citation reach for one run: how many error-free results cited an owned
 * domain (`cited`), over the All cohort (`all`, the denominator the rate is read
 * against). `cited`/`all` are kept alongside `rate` so a share never floats
 * without its population.
 */
export interface OwnedCitationReach {
  /** All cohort count (error-free) — the denominator. */
  all: number;
  /** owned_cited = true count — the Cited cohort. */
  cited: number;
  /** cited / all, or `null` when the run has no error-free results. */
  rate: number | null;
}

export function ownedCitationReach(
  rows: Iterable<OwnedCitationRow>,
): OwnedCitationReach {
  let all = 0;
  let cited = 0;
  for (const row of rows) {
    if (row.hasError) continue;
    all += 1;
    if (row.ownedCited === true) cited += 1;
  }
  return { all, cited, rate: all === 0 ? null : cited / all };
}

/** An owned-citation row tagged with its run — the reach-trend input. */
export interface OwnedCitationRunRow extends OwnedCitationRow {
  runDate: string;
}

/** One run's owned-citation reach. */
export interface OwnedReachPoint {
  runDate: string;
  reach: OwnedCitationReach;
}

/**
 * Group owned-citation rows by run and compute each run's reach — the trend over
 * run dates. Sorted by run date ascending so the series reads left→right as
 * time. Callers scope the input by segment/theme first, so the whole trend
 * respects the active scope.
 */
export function ownedCitationByRun(
  rows: Iterable<OwnedCitationRunRow>,
): OwnedReachPoint[] {
  const byRun = new Map<string, OwnedCitationRunRow[]>();
  for (const row of rows) {
    const bucket = byRun.get(row.runDate);
    if (bucket) bucket.push(row);
    else byRun.set(row.runDate, [row]);
  }
  return [...byRun.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([runDate, runRows]) => ({
      runDate,
      reach: ownedCitationReach(runRows),
    }));
}

/** One owned URL as cited in a single result — the per-URL breakdown input. */
export interface OwnedUrlRow {
  url: string;
  resultId: string;
  provider: string;
}

/** One owned URL with every result that cited it (within the active scope). */
export interface OwnedUrlAggregate {
  url: string;
  /** Distinct results that cited this URL — the ranking key. */
  resultCount: number;
  /** The citing results, for linking back to result-detail. Sorted by provider
   * then result id for stable rendering. */
  results: { resultId: string; provider: string }[];
}

/**
 * Aggregate owned-URL rows into distinct URLs, each carrying the results that
 * cited it. A URL cited twice within one result counts that result once (the
 * inner map is keyed by result id). Sorted by citing-result count desc, then
 * URL, for a stable "most-cited first" leaderboard.
 */
export function ownedUrlsByFrequency(
  rows: Iterable<OwnedUrlRow>,
): OwnedUrlAggregate[] {
  // url → (resultId → provider): dedupes a URL repeated within one result.
  const byUrl = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const resultsForUrl = byUrl.get(row.url) ?? new Map<string, string>();
    if (!resultsForUrl.has(row.resultId)) {
      resultsForUrl.set(row.resultId, row.provider);
    }
    byUrl.set(row.url, resultsForUrl);
  }
  return [...byUrl.entries()]
    .map(([url, resultsForUrl]) => ({
      url,
      resultCount: resultsForUrl.size,
      results: [...resultsForUrl.entries()]
        .map(([resultId, provider]) => ({ resultId, provider }))
        .sort((a, b) =>
          a.provider !== b.provider
            ? a.provider.localeCompare(b.provider)
            : a.resultId.localeCompare(b.resultId),
        ),
    }))
    .sort((a, b) =>
      b.resultCount !== a.resultCount
        ? b.resultCount - a.resultCount
        : a.url.localeCompare(b.url),
    );
}

// ── Prompt trajectory (issue #13) ─────────────────────────────────────────────
//
// Every prompt is a first-class entity with a trajectory over run dates — a line
// per provider (the dedicated page) and a mention sparkline previewing the trend
// (the list rows). The defining rule (PRD story #22): a run where the prompt is
// *absent* renders as a **gap**, never a zero — coverage gaps must not read as
// failures. Both builders below align their output to a caller-supplied
// `runOrder` (every ingested run date, ascending) and leave a `null` wherever the
// prompt has no result in a run, so the line breaks instead of dropping to 0.

/**
 * One (prompt × provider × run) result's contribution to a prompt trajectory —
 * the verdict signals a line can be drawn from, tagged with the run it belongs to
 * and the provider whose line it feeds. Shaped so a `results ⟕ verdicts` SELECT
 * row feeds it directly; every verdict field is nullable because the join is a
 * LEFT JOIN (an errored result carries no verdict).
 */
export interface PromptTrajectoryRow {
  runDate: string;
  provider: string;
  resultId: string;
  hasError: boolean;
  mentioned: boolean | null;
  accuracyScore: number | null;
  ownedCited: boolean | null;
  brandRank: string | null;
}

/** One run's cell on a provider's line — the result that ran, with its signals,
 * so the UI can plot any chosen metric and link the cell back to result-detail. */
export interface TrajectoryCell {
  runDate: string;
  resultId: string;
  hasError: boolean;
  mentioned: boolean | null;
  accuracyScore: number | null;
  ownedCited: boolean | null;
  brandRank: string | null;
}

/** One provider's trajectory: a cell per run in `runOrder`, `null` where this
 * prompt was absent from that run for this provider (the gap, not a zero). */
export interface ProviderTrajectory {
  provider: string;
  cells: (TrajectoryCell | null)[];
}

/**
 * Group one prompt's results into a dense per-provider trajectory aligned to
 * `runOrder`. Each provider gets an array the length of `runOrder`; a run with no
 * result for that provider stays `null` (a gap). Providers are sorted by name for
 * stable rendering / legend order. A row whose `runDate` isn't in `runOrder` is
 * dropped (defensive — callers pass the full ingested run list).
 */
export function promptTrajectoryByProvider(
  rows: Iterable<PromptTrajectoryRow>,
  runOrder: readonly string[],
): ProviderTrajectory[] {
  const runIndex = new Map(runOrder.map((d, i) => [d, i] as const));
  const byProvider = new Map<string, (TrajectoryCell | null)[]>();
  for (const r of rows) {
    const i = runIndex.get(r.runDate);
    if (i === undefined) continue;
    let cells = byProvider.get(r.provider);
    if (!cells) {
      cells = new Array<TrajectoryCell | null>(runOrder.length).fill(null);
      byProvider.set(r.provider, cells);
    }
    cells[i] = {
      runDate: r.runDate,
      resultId: r.resultId,
      hasError: r.hasError,
      mentioned: r.mentioned,
      accuracyScore: r.accuracyScore,
      ownedCited: r.ownedCited,
      brandRank: r.brandRank,
    };
  }
  return [...byProvider.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, cells]) => ({ provider, cells }));
}

/** One result's contribution to a prompt's mention sparkline — the run it ran in,
 * its error flag, and whether it mentioned the brand. A subset of
 * {@link PromptTrajectoryRow}, so the same SELECT feeds both. */
export interface PromptMentionRow {
  promptId: string;
  runDate: string;
  hasError: boolean;
  mentioned: boolean | null;
}

/**
 * One prompt's mention sparkline: the mention rate pooled across providers per
 * run (mentioned / error-free results that run), aligned to `runOrder`. A run
 * where the prompt has no error-free result is `null` (a gap), matching the
 * trajectory page's rule — an all-errored or absent run breaks the line rather
 * than reading as 0% mention. `latestRate` is the most recent non-null point (for
 * sorting/labeling the list); `present` is the total error-free results across
 * all runs (a presence weight).
 */
export interface PromptSparkline {
  promptId: string;
  mentionRate: (number | null)[];
  latestRate: number | null;
  present: number;
}

/**
 * Build a mention sparkline per prompt over `runOrder`. Errored results are
 * excluded from both numerator and denominator (a flake never lowers a prompt's
 * mention rate — the same exclusion the headline applies); a prompt-run left with
 * no error-free result is a `null` gap. Returns one entry per prompt seen in the
 * rows, unsorted (callers order/scope the list).
 */
export function promptSparklines(
  rows: Iterable<PromptMentionRow>,
  runOrder: readonly string[],
): PromptSparkline[] {
  const runIndex = new Map(runOrder.map((d, i) => [d, i] as const));
  // promptId → per-run { mentioned, all } tallies (all = error-free results).
  const byPrompt = new Map<string, { mentioned: number; all: number }[]>();
  for (const r of rows) {
    const i = runIndex.get(r.runDate);
    if (i === undefined) continue;
    let tally = byPrompt.get(r.promptId);
    if (!tally) {
      tally = runOrder.map(() => ({ mentioned: 0, all: 0 }));
      byPrompt.set(r.promptId, tally);
    }
    if (r.hasError) continue; // excluded from numerator and denominator
    const cell = tally[i];
    if (!cell) continue;
    cell.all += 1;
    if (r.mentioned === true) cell.mentioned += 1;
  }
  return [...byPrompt.entries()].map(([promptId, tally]) => {
    const mentionRate = tally.map((c) =>
      c.all === 0 ? null : c.mentioned / c.all,
    );
    let latestRate: number | null = null;
    for (let i = mentionRate.length - 1; i >= 0; i--) {
      const v = mentionRate[i];
      if (v != null) {
        latestRate = v;
        break;
      }
    }
    const present = tally.reduce((s, c) => s + c.all, 0);
    return { promptId, mentionRate, latestRate, present };
  });
}

export type DeltaDirection = "up" | "down" | "flat";

export interface Delta {
  /** current − prior, in the metric's own units; `null` when undefined. */
  absolute: number | null;
  direction: DeltaDirection | null;
}

/**
 * Week-over-week delta between a metric's current value and the prior run's.
 * Returns a null delta when there is no prior run or either value is undefined
 * (an empty cohort). Computed from the two values passed in — callers derive
 * those live from the DB, so a retroactively re-judged prior run is always
 * reflected. Every headline metric shares the same polarity (higher is better),
 * so direction maps directly onto green = gain / red = loss in the UI.
 */
export function metricDelta(
  current: number | null | undefined,
  prior: number | null | undefined,
): Delta {
  if (current == null || prior == null) {
    return { absolute: null, direction: null };
  }
  const absolute = current - prior;
  const direction: DeltaDirection =
    absolute > 0 ? "up" : absolute < 0 ? "down" : "flat";
  return { absolute, direction };
}

/**
 * Flip a delta's *polarity* for a lower-is-better metric (the coverage table's
 * error rate). `direction` is what the UI colors by, so a rising error rate must
 * arrive at the view already reading as "down" (red) — the sign in `absolute`
 * stays untouched, so the cell still renders `+2.0` while colored as a loss.
 * Applied here, at the data boundary, rather than in the view: the client can't
 * import runtime values from this package (it would drag the Postgres driver into
 * the browser bundle), so polarity is a property of the shipped delta.
 */
export function invertDirection(d: Delta): Delta {
  if (d.direction === null) return d;
  return {
    absolute: d.absolute,
    direction:
      d.direction === "up" ? "down" : d.direction === "down" ? "up" : "flat",
  };
}

/** Per-metric WoW deltas (current run vs prior), keyed by metric. Shared by the
 * pooled headline and every scoreboard table row, so a headline delta and a
 * provider/theme row delta are computed by the same code. */
export interface HeadlineDeltas {
  mentionRate: Delta;
  avgAccuracy: Delta;
  ownedCitationRate: Delta;
  firstPlaceRate: Delta;
}

const NULL_DELTA: Delta = { absolute: null, direction: null };

/** Every metric undefined — no prior run, or no prior counterpart for this key. */
export const NO_DELTAS: HeadlineDeltas = {
  mentionRate: NULL_DELTA,
  avgAccuracy: NULL_DELTA,
  ownedCitationRate: NULL_DELTA,
  firstPlaceRate: NULL_DELTA,
};

/**
 * The four headline deltas between a current headline and its prior counterpart.
 * All four share the same polarity (higher is better), so `direction` maps
 * straight onto green = gain / red = loss. A null prior (no prior run, or no
 * prior row for this key) yields {@link NO_DELTAS}; an empty cohort on either
 * side yields a null delta for that metric alone (via {@link metricDelta}), which
 * the UI renders as "—".
 */
export function headlineDeltas(
  current: HeadlineMetrics,
  prior: HeadlineMetrics | null,
): HeadlineDeltas {
  if (!prior) return NO_DELTAS;
  return {
    mentionRate: metricDelta(current.mentionRate.rate, prior.mentionRate.rate),
    avgAccuracy: metricDelta(current.avgAccuracy.mean, prior.avgAccuracy.mean),
    ownedCitationRate: metricDelta(
      current.ownedCitationRate.rate,
      prior.ownedCitationRate.rate,
    ),
    firstPlaceRate: metricDelta(
      current.firstPlaceRate.rate,
      prior.firstPlaceRate.rate,
    ),
  };
}

/**
 * One table row's delta state. Three cases the UI must render differently:
 *   - `none` — there is no prior run at all (the earliest ingested run). No delta
 *     affordance is drawn; the meta line already explains why.
 *   - `new`  — a prior run exists but this key isn't in it. The row is *new*,
 *     which is a fact, not a missing value — never rendered as "—".
 *   - `delta` — a real comparison against the prior run's row of the same key.
 *
 * Keys present in the prior run and absent from the active one are simply not
 * here: no phantom rows are synthesized (callers may surface the dropped count).
 */
export type RowDeltas =
  | { kind: "none" }
  | { kind: "new" }
  | {
      kind: "delta";
      metrics: HeadlineDeltas;
      /** Signed change in the All-cohort count. **Neutral polarity** — a bigger
       * or smaller denominator is neither good nor bad — so `direction` carries
       * the sign only and the view must not color it green/red. */
      all: Delta;
    };

function rowDeltas(
  current: HeadlineMetrics,
  prior: HeadlineMetrics | undefined,
  hasPriorRun: boolean,
): RowDeltas {
  if (!hasPriorRun) return { kind: "none" };
  if (!prior) return { kind: "new" };
  return {
    kind: "delta",
    metrics: headlineDeltas(current, prior),
    all: metricDelta(current.funnel.all, prior.funnel.all),
  };
}

/** A provider breakdown row carrying its WoW delta against the prior run. */
export interface ProviderMetricsRow extends ProviderMetrics {
  deltas: RowDeltas;
}

/** A theme breakdown row carrying its WoW delta against the prior run. */
export interface ThemeMetricsRow extends ThemeMetrics {
  deltas: RowDeltas;
}

/**
 * Join a run's per-provider breakdown to the prior run's by provider name. Both
 * sides must already be scoped identically (same segment), so a delta never
 * compares a segment against the whole. `prior === null` means *no prior run
 * exists* — distinct from a provider missing from a prior run that does exist,
 * which is `new`.
 */
export function withProviderDeltas(
  active: readonly ProviderMetrics[],
  prior: readonly ProviderMetrics[] | null,
): ProviderMetricsRow[] {
  const byKey = new Map((prior ?? []).map((p) => [p.provider, p]));
  return active.map((a) => ({
    ...a,
    deltas: rowDeltas(a, byKey.get(a.provider), prior !== null),
  }));
}

/** Join a run's per-theme cross-tab to the prior run's by theme. The null-theme
 * bucket is a real key (rendered "Uncategorized"), so it joins to the prior run's
 * null-theme bucket — the map is keyed by the nullable theme itself rather than by
 * a string sentinel that a real theme could collide with. See
 * {@link withProviderDeltas}. */
export function withThemeDeltas(
  active: readonly ThemeMetrics[],
  prior: readonly ThemeMetrics[] | null,
): ThemeMetricsRow[] {
  const byKey = new Map<string | null, ThemeMetrics>(
    (prior ?? []).map((p) => [p.theme, p]),
  );
  return active.map((a) => ({
    ...a,
    deltas: rowDeltas(a, byKey.get(a.theme), prior !== null),
  }));
}

/**
 * A coverage row's delta state. Mirrors {@link RowDeltas}, but over the coverage
 * table's own columns: `errorRate` is **lower-is-better**, so it arrives with its
 * polarity already inverted (a rising error rate reads as a loss); the two count
 * columns are neutral.
 */
export type CoverageDeltas =
  | { kind: "none" }
  | { kind: "new" }
  | {
      kind: "delta";
      /** Polarity inverted (see {@link invertDirection}): up = red. */
      errorRate: Delta;
      /** Neutral — sign only, never colored. */
      attempted: Delta;
      /** Neutral — sign only, never colored. */
      errored: Delta;
    };

/** A coverage row carrying its WoW deltas against the prior run. */
export interface ProviderCoverageRow extends ProviderCoverage {
  deltas: CoverageDeltas;
}

/** Join a run's per-provider coverage to the prior run's by provider name. See
 * {@link withProviderDeltas}; error-rate polarity is inverted here. */
export function withCoverageDeltas(
  active: readonly ProviderCoverage[],
  prior: readonly ProviderCoverage[] | null,
): ProviderCoverageRow[] {
  const byKey = new Map((prior ?? []).map((p) => [p.provider, p]));
  return active.map((a) => {
    const p = byKey.get(a.provider);
    if (prior === null) return { ...a, deltas: { kind: "none" as const } };
    if (!p) return { ...a, deltas: { kind: "new" as const } };
    return {
      ...a,
      deltas: {
        kind: "delta" as const,
        errorRate: invertDirection(metricDelta(a.errorRate, p.errorRate)),
        attempted: metricDelta(a.attempted, p.attempted),
        errored: metricDelta(a.errored, p.errored),
      },
    };
  });
}

/** How many keys the prior run had that the active run doesn't — surfaced as a
 * count (e.g. "2 dropped since 2026-08-06") rather than as phantom rows. */
export function countDropped<K>(
  activeKeys: Iterable<K>,
  priorKeys: Iterable<K> | null,
): number {
  if (priorKeys === null) return 0;
  const active = new Set(activeKeys);
  let dropped = 0;
  for (const k of priorKeys) if (!active.has(k)) dropped += 1;
  return dropped;
}
