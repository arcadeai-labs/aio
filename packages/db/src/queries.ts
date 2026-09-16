// SQL-backed read queries for the dashboard. These touch the live DB and feed
// the pure functions in `metrics.ts`, so every number reflects the *current*
// state of the corpus — a historical run re-judged after the fact changes its
// rates (and any delta against them) on the next page load, with no precomputed
// comparison files involved (PRD story #31).

import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "./client.js";
import {
  type BrandShareOfVoice,
  type BrandSovPoint,
  type CompetitivePoint,
  type CompetitiveRunRow,
  type CompetitorSeries,
  type HeadlineDeltas,
  type HeadlineMetrics,
  NO_DELTAS,
  type OwnedCitationReach,
  type OwnedCitationRunRow,
  type OwnedReachPoint,
  type OwnedUrlAggregate,
  type OwnedUrlRow,
  type PromptSparkline,
  type ProviderCoverageRow,
  type ProviderMetricsRow,
  type ProviderTrajectory,
  type RankDistribution,
  type ScopedRow,
  type Segment,
  type ThemeMetricsRow,
  brandShareOfVoiceTrend,
  competitiveByRun,
  countDropped,
  coverageByProvider,
  filterBySegment,
  filterByTheme,
  headlineDeltas,
  headlineMetrics,
  metricsByProvider,
  metricsByTheme,
  ownedCitationByRun,
  ownedUrlsByFrequency,
  promptSparklines,
  promptTrajectoryByProvider,
  shareOfVoiceTrend,
  withCoverageDeltas,
  withProviderDeltas,
  withThemeDeltas,
} from "./metrics.js";
import {
  citations,
  competitorMentions,
  configSnapshots,
  ingestRuns,
  prompts,
  results,
  searchQueries,
  searchResults,
  verdictExcerpts,
  verdictOwnedUrls,
  verdicts,
} from "./schema/analytics.js";

/** Ingested run dates, newest first — the authoritative run list (provenance). */
export async function runDatesDesc(): Promise<string[]> {
  const rows = await db
    .select({ runDate: ingestRuns.runDate })
    .from(ingestRuns)
    .orderBy(desc(ingestRuns.runDate));
  return rows.map((r) => r.runDate);
}

/**
 * A headline cohort row plus the provider it belongs to (for coverage) and its
 * as-run segment/theme classification (for scoping). Extends {@link ScopedRow},
 * so segment/theme filtering applies directly to query output.
 */
export interface ProviderMetricRow extends ScopedRow {
  provider: string;
}

/**
 * Every result for one run, carrying its error flag, provider, as-run
 * segment/theme, and (via LEFT JOIN) the verdict fields the headline cohorts are
 * computed from. The same rows feed `headlineMetrics` (pooled, error-free),
 * `coverageByProvider` (per-provider, includes errors), and the segment/theme
 * scoping — so the tested logic and the production logic are identical. Scoping
 * happens in memory: a run is ~3,198 rows, trivially small.
 */
export async function metricRowsForRun(
  runDate: string,
): Promise<ProviderMetricRow[]> {
  return db
    .select({
      provider: results.provider,
      hasError: results.hasError,
      runBrandedType: results.runBrandedType,
      runTheme: results.runTheme,
      mentioned: verdicts.mentioned,
      accuracyScore: verdicts.accuracyScore,
      ownedCited: verdicts.ownedCited,
      othersPresent: verdicts.othersPresent,
      brandRank: verdicts.brandRank,
    })
    .from(results)
    .leftJoin(verdicts, eq(verdicts.resultId, results.id))
    .where(eq(results.runDate, runDate));
}

export interface RunHeadline extends HeadlineMetrics {
  runDate: string;
}

/**
 * Per-run freshness/provenance for the active run (issue #8), read straight from
 * the `ingest_runs` row that the reconciler writes on every ingest. Surfaces
 * ingested-at + row counts and makes partial/missing runs detectable:
 * `status !== 'ok'` or `orphanVerdictCount > 0` flags a run the UI should warn
 * on. `ingestedAt` is normalized to an ISO string so it crosses the server→client
 * boundary as plain JSON (mirrors {@link RunSummary} in web/src/lib/runs.ts).
 */
export interface RunProvenance {
  runDate: string;
  resultCount: number;
  verdictCount: number;
  orphanVerdictCount: number;
  status: string;
  ingestedAt: string;
}

export async function runProvenance(
  runDate: string,
): Promise<RunProvenance | null> {
  const [r] = await db
    .select()
    .from(ingestRuns)
    .where(eq(ingestRuns.runDate, runDate))
    .limit(1);
  if (!r) return null;
  return {
    runDate: r.runDate,
    resultCount: r.resultCount,
    verdictCount: r.verdictCount,
    orphanVerdictCount: r.orphanVerdictCount,
    status: r.status,
    ingestedAt:
      r.ingestedAt instanceof Date
        ? r.ingestedAt.toISOString()
        : String(r.ingestedAt),
  };
}

// `HeadlineDeltas`/`NO_DELTAS` are pure and now live in metrics.ts alongside
// `Delta`/`metricDelta` (so the pooled headline and every table row compute
// deltas through the same `headlineDeltas` helper). Re-exported here for the
// callers that have always imported them from this module.
export type { HeadlineDeltas } from "./metrics.js";

export interface Scoreboard {
  /** The segment this scoreboard is scoped to (echoed back for the UI/URL). */
  segment: Segment;
  /**
   * Every ingested run date, newest first — the run switcher's options and the
   * basis for prev/next stepping by *actual run date* (not calendar weeks, since
   * cadence isn't exactly 7 days). The active run is `active.runDate`.
   */
  runDates: string[];
  /** The active (selected, or latest by default) run's headline. */
  active: RunHeadline | null;
  /** The run immediately before the active one by date (the WoW comparison base). */
  prior: RunHeadline | null;
  deltas: HeadlineDeltas;
  /**
   * Per-provider coverage/error for the active run (errors excluded above), each
   * row carrying its own WoW delta against the prior run's row for that provider
   * — error-rate polarity already inverted (lower is better).
   */
  coverage: ProviderCoverageRow[];
  /**
   * Per-provider headline breakdown for the active run, scoped to the current
   * segment — the pooled headline expanded one level down (issue #8). Always
   * computed; the UI reveals it via a toggle. Empty when there is no run. Each
   * row carries its WoW delta against the same provider in the prior run.
   */
  providers: ProviderMetricsRow[];
  /**
   * Per-theme headline within the current segment (segment × theme cross-tab),
   * for the active run. Always computed; the UI reveals it via the theme
   * breakdown toggle. Empty when there is no run. Each row carries its WoW delta
   * against the same theme in the prior run.
   */
  themes: ThemeMetricsRow[];
  /** Providers/themes that were in the prior run and are gone from the active one.
   * No phantom rows are synthesized for them; the counts let the UI say so. */
  dropped: { providers: number; themes: number };
  /** Freshness/provenance for the active run (ingested-at, counts, status). */
  provenance: RunProvenance | null;
}

const EMPTY_SCOREBOARD = (segment: Segment): Scoreboard => ({
  segment,
  runDates: [],
  active: null,
  prior: null,
  deltas: NO_DELTAS,
  coverage: [],
  providers: [],
  themes: [],
  dropped: { providers: 0, themes: 0 },
  provenance: null,
});

/**
 * The home scoreboard, scoped to a segment (default `global`) and to a run
 * (default: the latest). The run switcher (issue #8) passes a `runDate`; an
 * unknown/absent date falls back to the latest ingested run, so a hand-typed URL
 * can't wedge the page. For the active run this returns its full headline (all
 * four metrics + cohort funnel), per-provider coverage, the per-provider
 * breakdown, the per-theme cross-tab within the segment, freshness/provenance,
 * and each metric's WoW delta against the *immediately prior run date* — the run
 * before the active one, not a 7-day assumption (cadence is irregular). Segment
 * scoping re-scopes the headline, funnel, coverage, both breakdowns, *and* the
 * prior run the delta is taken against, so a delta never compares a segment
 * against the whole. Every value is computed live.
 */
export async function scoreboard(
  segment: Segment = "global",
  runDate?: string,
): Promise<Scoreboard> {
  const dates = await runDatesDesc();
  if (dates.length === 0) {
    return EMPTY_SCOREBOARD(segment);
  }

  // Step run-to-run by actual run date: the active run is the requested date if
  // it's a real ingested run, else the latest. The prior run is the next-older
  // date in the desc list — the WoW base, regardless of how irregular the gap.
  const activeDate =
    runDate && dates.includes(runDate) ? runDate : (dates[0] as string);
  const activeIdx = dates.indexOf(activeDate);
  const priorDate = dates[activeIdx + 1] ?? null;

  // The active rows, the active run's provenance, and the prior run's rows are
  // three independent reads — fire them together rather than serially.
  const [activeRaw, provenance, priorRaw] = await Promise.all([
    metricRowsForRun(activeDate),
    runProvenance(activeDate),
    priorDate ? metricRowsForRun(priorDate) : Promise.resolve(null),
  ]);

  const activeRows = filterBySegment(activeRaw, segment);
  const active: RunHeadline = {
    runDate: activeDate,
    ...headlineMetrics(activeRows),
  };
  // The prior run re-scoped to the same segment. Every per-row delta below is
  // derived from these rows — the ones already fetched above — so the per-key
  // deltas cost no extra DB round-trip, and a delta never compares a segment
  // against the whole.
  const priorRows =
    priorRaw === null ? null : filterBySegment(priorRaw, segment);

  const prior: RunHeadline | null =
    priorDate && priorRows
      ? { runDate: priorDate, ...headlineMetrics(priorRows) }
      : null;

  // Coverage is computed over the *scoped* rows, so error rates re-scope with the
  // segment. This relies on errored results still carrying their `run_branded_type`
  // (set from the prompt at ingest, independent of error status — see
  // ingest/transform.ts), so a provider's failures stay visible inside
  // branded/unbranded, not silently dropped for lacking a classification.
  //
  // Each breakdown runs over the active *and* the prior scoped rows, then joins by
  // key (provider / theme) — so every table row carries the same
  // immediately-prior-run comparison the pooled headline uses.
  const priorProviders = priorRows ? metricsByProvider(priorRows) : null;
  const priorThemes = priorRows ? metricsByTheme(priorRows) : null;
  const priorCoverage = priorRows ? coverageByProvider(priorRows) : null;

  const providersActive = metricsByProvider(activeRows);
  const themesActive = metricsByTheme(activeRows);

  const coverage = withCoverageDeltas(
    coverageByProvider(activeRows),
    priorCoverage,
  );
  const providers = withProviderDeltas(providersActive, priorProviders);
  const themes = withThemeDeltas(themesActive, priorThemes);

  const deltas = headlineDeltas(active, prior);

  return {
    segment,
    runDates: dates,
    active,
    prior,
    deltas,
    coverage,
    providers,
    themes,
    dropped: {
      providers: countDropped(
        providersActive.map((p) => p.provider),
        priorProviders?.map((p) => p.provider) ?? null,
      ),
      themes: countDropped(
        themesActive.map((t) => t.theme),
        priorThemes?.map((t) => t.theme) ?? null,
      ),
    },
    provenance,
  };
}

/**
 * One prompt-result row in the provider drill-down list (issue #9). Carries the
 * same per-row signals the scoreboard aggregates ({@link ScopedRow}: error flag,
 * the verdict fields, and as-run segment/theme) plus the identity the list needs
 * to render and link a row: the result id (→ result-detail view), its prompt id,
 * and the prompt text. Verdict fields stay nullable — an errored result (or a
 * LEFT JOIN miss) has no verdict, and the list renders that as "—" rather than
 * dropping the row, so a flaking provider's failures are visible in the list.
 */
export interface DrilldownRow extends ScopedRow {
  resultId: string;
  promptId: string;
  promptText: string;
}

/**
 * Every prompt-result for one run × one provider, with its prompt text and
 * verdict signals. Indexed by `results(run_date, provider)`. Errored results are
 * kept (LEFT JOIN to verdicts) so the list can show provider failures; the
 * caller scopes by segment in memory (≤533 rows — one prompt set, one provider).
 */
export async function drilldownRowsForRunProvider(
  runDate: string,
  provider: string,
): Promise<DrilldownRow[]> {
  return db
    .select({
      resultId: results.id,
      promptId: results.promptId,
      promptText: prompts.text,
      hasError: results.hasError,
      runBrandedType: results.runBrandedType,
      runTheme: results.runTheme,
      mentioned: verdicts.mentioned,
      accuracyScore: verdicts.accuracyScore,
      ownedCited: verdicts.ownedCited,
      othersPresent: verdicts.othersPresent,
      brandRank: verdicts.brandRank,
    })
    .from(results)
    .innerJoin(prompts, eq(prompts.promptId, results.promptId))
    .leftJoin(verdicts, eq(verdicts.resultId, results.id))
    .where(and(eq(results.runDate, runDate), eq(results.provider, provider)));
}

/**
 * The provider drill-down (issue #9): the list of a run × provider's
 * prompt-results, scoped to a segment. Mirrors {@link scoreboard}'s run
 * resolution — an unknown/absent run date falls back to the latest ingested run,
 * so a hand-typed URL can't wedge the page. Segment scoping reuses the same
 * `filterBySegment` the scoreboard uses, so a row appears in the drill-down iff
 * it counted toward that segment's headline. Sorting/filtering by the per-row
 * signals happens client-side over this list (the set is tiny). `exists` is false
 * when no run is ingested or the provider has no rows in the resolved run, which
 * the UI renders as an empty/unknown-provider state rather than a blank table.
 */
export interface ProviderDrilldown {
  /** The resolved run date (requested if real, else latest); null if no runs. */
  runDate: string | null;
  provider: string;
  segment: Segment;
  /** True when the resolved run has at least one result for this provider. */
  exists: boolean;
  rows: DrilldownRow[];
}

export async function providerDrilldown(
  provider: string,
  segment: Segment = "global",
  runDate?: string,
): Promise<ProviderDrilldown> {
  const dates = await runDatesDesc();
  if (dates.length === 0) {
    return { runDate: null, provider, segment, exists: false, rows: [] };
  }
  const activeDate =
    runDate && dates.includes(runDate) ? runDate : (dates[0] as string);
  const raw = await drilldownRowsForRunProvider(activeDate, provider);
  return {
    runDate: activeDate,
    provider,
    segment,
    exists: raw.length > 0,
    rows: filterBySegment(raw, segment),
  };
}

/** A URL the provider explicitly cited in its answer. */
export interface CitationDetail {
  url: string;
  title: string | null;
  citedText: string | null;
}

/** A query the provider issued against its search tool. */
export interface SearchQueryDetail {
  query: string;
}

/** A page the provider's search tool surfaced (not necessarily cited). */
export interface SearchResultDetail {
  url: string;
  title: string | null;
  snippet: string | null;
}

/**
 * One result's complete record for the editorial result-detail view (issue #10):
 * the prompt and its metadata, the response, every citation / search query /
 * search result, and the full judge verdict (mention excerpts, accuracy score +
 * reasoning, competitive position, hypothesis). Returns null when the id is
 * unknown. The verdict is null for an errored result (no verdict was produced);
 * the UI shows the error instead. The child arrays are empty (never null) when a
 * provider returned nothing for that section, so the view renders graceful
 * "none" states rather than broken boxes.
 */
export interface ResultDetail {
  resultId: string;
  runDate: string;
  provider: string;
  model: string;
  promptId: string;
  promptText: string;
  theme: string | null;
  brandedType: string | null;
  // promptMeta — the structured, as-run execution context around the call.
  location: string | null;
  isRelevant: boolean;
  searchTool: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  responseText: string;
  hasError: boolean;
  errorMessage: string | null;
  citations: CitationDetail[];
  searchQueries: SearchQueryDetail[];
  searchResults: SearchResultDetail[];
  verdict: {
    mentioned: boolean;
    mentionCount: number;
    accuracyScore: number | null;
    accuracyReasoning: string | null;
    ownedCited: boolean;
    othersPresent: boolean;
    othersCount: number;
    brandRank: string;
    mentionHypothesis: string | null;
    excerpts: string[];
    ownedUrls: string[];
    competitors: string[];
  } | null;
}

export async function resultDetail(id: string): Promise<ResultDetail | null> {
  const [r] = await db
    .select({
      resultId: results.id,
      runDate: results.runDate,
      provider: results.provider,
      model: results.model,
      promptId: results.promptId,
      promptText: prompts.text,
      location: prompts.location,
      isRelevant: prompts.isRelevant,
      theme: results.runTheme,
      brandedType: results.runBrandedType,
      searchTool: results.searchTool,
      latencyMs: results.latencyMs,
      inputTokens: results.inputTokens,
      outputTokens: results.outputTokens,
      estimatedCostUsd: results.estimatedCostUsd,
      responseText: results.responseText,
      hasError: results.hasError,
      errorMessage: results.errorMessage,
      mentioned: verdicts.mentioned,
      mentionCount: verdicts.mentionCount,
      accuracyScore: verdicts.accuracyScore,
      accuracyReasoning: verdicts.accuracyReasoning,
      ownedCited: verdicts.ownedCited,
      othersPresent: verdicts.othersPresent,
      othersCount: verdicts.othersCount,
      brandRank: verdicts.brandRank,
      mentionHypothesis: verdicts.mentionHypothesis,
    })
    .from(results)
    .innerJoin(prompts, eq(prompts.promptId, results.promptId))
    .leftJoin(verdicts, eq(verdicts.resultId, results.id))
    .where(eq(results.id, id))
    .limit(1);
  if (!r) return null;

  // Child collections in parallel — ordered by serial id so the view shows them
  // in ingest (≈ provider) order, except competitor mentions which read better
  // alphabetically. Verdict children are fetched unconditionally; they're empty
  // unless a verdict was produced, which the verdict-null check below folds away.
  const [
    citationRows,
    queryRows,
    searchResultRows,
    excerptRows,
    ownedUrlRows,
    competitorRows,
  ] = await Promise.all([
    db
      .select({
        url: citations.url,
        title: citations.title,
        citedText: citations.citedText,
      })
      .from(citations)
      .where(eq(citations.resultId, id))
      .orderBy(asc(citations.id)),
    db
      .select({ query: searchQueries.query })
      .from(searchQueries)
      .where(eq(searchQueries.resultId, id))
      .orderBy(asc(searchQueries.id)),
    db
      .select({
        url: searchResults.url,
        title: searchResults.title,
        snippet: searchResults.snippet,
      })
      .from(searchResults)
      .where(eq(searchResults.resultId, id))
      .orderBy(asc(searchResults.id)),
    db
      .select({ excerpt: verdictExcerpts.excerpt })
      .from(verdictExcerpts)
      .where(eq(verdictExcerpts.resultId, id))
      .orderBy(asc(verdictExcerpts.id)),
    db
      .select({ url: verdictOwnedUrls.url })
      .from(verdictOwnedUrls)
      .where(eq(verdictOwnedUrls.resultId, id))
      .orderBy(asc(verdictOwnedUrls.id)),
    db
      .select({ name: competitorMentions.competitorName })
      .from(competitorMentions)
      .where(eq(competitorMentions.resultId, id))
      .orderBy(asc(competitorMentions.competitorName)),
  ]);

  return {
    resultId: r.resultId,
    runDate: r.runDate,
    provider: r.provider,
    model: r.model,
    promptId: r.promptId,
    promptText: r.promptText,
    theme: r.theme,
    brandedType: r.brandedType,
    location: r.location,
    isRelevant: r.isRelevant,
    searchTool: r.searchTool,
    latencyMs: r.latencyMs,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    estimatedCostUsd: r.estimatedCostUsd,
    responseText: r.responseText,
    hasError: r.hasError,
    errorMessage: r.errorMessage,
    citations: citationRows,
    searchQueries: queryRows,
    searchResults: searchResultRows,
    // A verdict exists iff the LEFT JOIN matched — `mentioned` is NOT NULL in the
    // verdicts table, so its nullness here is the join-miss signal.
    verdict:
      r.mentioned === null
        ? null
        : {
            mentioned: r.mentioned,
            mentionCount: r.mentionCount as number,
            accuracyScore: r.accuracyScore,
            accuracyReasoning: r.accuracyReasoning,
            ownedCited: r.ownedCited as boolean,
            othersPresent: r.othersPresent as boolean,
            othersCount: r.othersCount as number,
            brandRank: r.brandRank as string,
            mentionHypothesis: r.mentionHypothesis,
            excerpts: excerptRows.map((e) => e.excerpt),
            ownedUrls: ownedUrlRows.map((u) => u.url),
            competitors: competitorRows.map((c) => c.name),
          },
  };
}

// ── Competitive landscape (issue #11) ────────────────────────────────────────

/** The "all themes" sentinel for the competitive view's theme scope (mirrors the
 * drill-down's THEME_ALL). A concrete theme filters; this (or absence) doesn't. */
export const COMPETITIVE_THEME_ALL = "all";

/**
 * A competitive row as it leaves the DB: the trend input ({@link CompetitiveRunRow}
 * — run date, error flag, cohort flag, rank, competitors) plus the as-run
 * classification the segment/theme scope filters on. The generic
 * {@link filterBySegment}/{@link filterByTheme} preserve these extra fields, so
 * the same scoped set feeds the trend.
 */
interface CompetitiveQueryRow extends CompetitiveRunRow {
  runBrandedType: string | null;
  runTheme: string | null;
}

/**
 * Every competitive result (`others_present = true`) across all runs, with its
 * as-run segment/theme and the competitors mentioned in it. The cohort filter
 * lives in SQL (INNER JOIN verdicts WHERE others_present), so errored results —
 * which have no verdict — are excluded by construction. Competitors come from a
 * second indexed read joined the same way (`competitor_mentions` only stores
 * mentioned=true rows) and are stitched in by result id, so each row carries its
 * mentioned-competitor list. Two reads over a few tens of thousands of rows total.
 */
async function competitiveRows(): Promise<CompetitiveQueryRow[]> {
  const [base, mentions] = await Promise.all([
    db
      .select({
        runDate: results.runDate,
        resultId: results.id,
        hasError: results.hasError,
        runBrandedType: results.runBrandedType,
        runTheme: results.runTheme,
        othersPresent: verdicts.othersPresent,
        brandRank: verdicts.brandRank,
        // The brand's own mention flag on the competitive row — what makes the
        // brand readable on the competitors' denominator (`brandShareOfVoice`).
        mentioned: verdicts.mentioned,
      })
      .from(results)
      .innerJoin(verdicts, eq(verdicts.resultId, results.id))
      .where(eq(verdicts.othersPresent, true)),
    db
      .select({
        resultId: competitorMentions.resultId,
        name: competitorMentions.competitorName,
      })
      .from(competitorMentions)
      .innerJoin(verdicts, eq(verdicts.resultId, competitorMentions.resultId))
      .where(eq(verdicts.othersPresent, true)),
  ]);

  const byResult = new Map<string, string[]>();
  for (const m of mentions) {
    const bucket = byResult.get(m.resultId);
    if (bucket) bucket.push(m.name);
    else byResult.set(m.resultId, [m.name]);
  }

  return base.map((r) => ({
    runDate: r.runDate,
    hasError: r.hasError,
    othersPresent: r.othersPresent,
    brandRank: r.brandRank,
    mentioned: r.mentioned,
    runBrandedType: r.runBrandedType,
    runTheme: r.runTheme,
    competitors: byResult.get(r.resultId) ?? [],
  }));
}

/** The brand label for a run, from that run's `config_snapshots` row (written per
 * run by the ingest reconciler).
 *
 * The fallback is a deliberately generic placeholder, used only when a run
 * predates the snapshot or the ingest didn't carry a config. It must never be a
 * real brand name: a wrong-but-plausible label is indistinguishable from a
 * correct one in the UI, so a missing snapshot would silently mislabel a whole
 * run's charts rather than looking obviously unset. */
export const DEFAULT_BRAND_NAME = "Brand";

async function brandNameForRun(runDate: string): Promise<string> {
  const [snap] = await db
    .select({ brandName: configSnapshots.brandName })
    .from(configSnapshots)
    .where(eq(configSnapshots.runDate, runDate))
    .limit(1);
  return snap?.brandName ?? DEFAULT_BRAND_NAME;
}

// How many competitors the view ships. The judge's competitor field is a long
// free-text tail (tens of thousands of distinct strings across the corpus:
// canonical names plus one-off "Other: …" descriptions), so the full set is
// never sent to the browser. The capped head is the competitors that carry the
// signal; `sovTotal` reports the true distinct count so the UI can label the cap.

/** Competitors in the focused-run leaderboard (horizontal bars). */
export const SOV_LEADERBOARD_LIMIT = 10;
/** Per-competitor series shipped for the share-of-voice line chart / table. Wide
 * enough to read as a field of competitors; the client emphasizes its own top
 * slice and dims the rest. */
export const SOV_TREND_LIMIT = 30;

/** One run's rank distribution — the lean per-run row of the rank trend table
 * (the full per-run SoV is intentionally not shipped for every run). */
export interface RankTrendPoint {
  runDate: string;
  rankDistribution: RankDistribution;
}

export interface CompetitiveLandscape {
  segment: Segment;
  /** The active theme scope: COMPETITIVE_THEME_ALL or a concrete theme. */
  theme: string;
  /** All ingested run dates, newest first (run switcher + context). */
  runDates: string[];
  /** Themes present in the competitive cohort within the segment (filter options). */
  themes: string[];
  /** The resolved active run (requested if real, else latest); null if no runs. */
  activeRunDate: string | null;
  /** The active run's competitive picture (SoV capped to
   * {@link SOV_LEADERBOARD_LIMIT}), or null when that run has no competitive rows
   * in scope. */
  current: CompetitivePoint | null;
  /** Distinct competitors mentioned in the active run *before* the leaderboard
   * cap, so the leaderboard can honestly say "top N of M" (mirrors `sovTotal`). */
  currentSovTotal: number;
  /** Brand-rank distribution per run, oldest→newest — the rank trend (line chart). */
  rankTrend: RankTrendPoint[];
  /** Top per-competitor SoV series across runs (capped to {@link SOV_TREND_LIMIT}),
   * ranked by total mentions — the share-of-voice line chart / table. */
  sovTrend: CompetitorSeries[];
  /** True count of distinct competitors in scope, so the UI can say "top N of M". */
  sovTotal: number;
  /**
   * The brand's own share of voice in the active run — `count(mentioned) /
   * competitive`, the *same* denominator every competitor's share uses, so the
   * two are directly comparable. Deliberately a parallel field rather than an
   * entry in `current.shareOfVoice.competitors`: the brand is not a competitor,
   * so it must never enter `sovTotal`, the "top N of M competitors" label, or
   * spend one of the {@link SOV_LEADERBOARD_LIMIT} / {@link SOV_TREND_LIMIT}
   * slots. Null when the active run has no competitive rows in scope.
   *
   * ⚠️ Not the headline mention rate (denominator: the All cohort). The UI must
   * label it as competitive-cohort share so the two can't be confused.
   */
  brandSov: BrandShareOfVoice | null;
  /** The brand's SoV per run, oldest→newest — always the full series (never
   * capped), so the brand line is always drawable. */
  brandSovTrend: BrandSovPoint[];
  /** The brand's 1-based position among *all* competitors in the active run by
   * share (ties resolved in the brand's favour). Null when there's no active
   * point. Lets the leaderboard say "#3 of 27 by share of voice". */
  brandSovRank: number | null;
  /** The brand's display label, from the active run's `config_snapshots` row
   * (falls back to `Taskwell`). */
  brandName: string;
}

const EMPTY_LANDSCAPE = (
  segment: Segment,
  theme: string | undefined,
): CompetitiveLandscape => ({
  segment,
  theme: theme ?? COMPETITIVE_THEME_ALL,
  runDates: [],
  themes: [],
  activeRunDate: null,
  current: null,
  currentSovTotal: 0,
  rankTrend: [],
  sovTrend: [],
  sovTotal: 0,
  brandSov: null,
  brandSovTrend: [],
  brandSovRank: null,
  brandName: DEFAULT_BRAND_NAME,
});

/** Cap a run's competitive picture for the wire: keep its (small) rank
 * distribution whole, trim its SoV to the display head. */
function capPoint(point: CompetitivePoint): CompetitivePoint {
  return {
    ...point,
    shareOfVoice: {
      competitive: point.shareOfVoice.competitive,
      competitors: point.shareOfVoice.competitors.slice(
        0,
        SOV_LEADERBOARD_LIMIT,
      ),
    },
  };
}

/**
 * The Competitive Landscape view (issue #11), scoped to a segment and (optionally)
 * a theme. Everything is taken over the competitive cohort (`others_present =
 * true`), so `current.rankDistribution.competitive` is the denominator the UI
 * labels every share against. `rankTrend` is one rank distribution per run date
 * (ascending) and `sovTrend` is per-competitor share-of-voice across those runs —
 * the two trends, computed live. `current` is the active run's point (the
 * requested run if real, else the latest), or null when no run carries a
 * competitive result in the active scope. `themes` lists the themes present in the
 * competitive cohort *within the current segment*, for the theme filter;
 * `runDates` is the full newest-first run list (the run switcher).
 */
export async function competitiveLandscape(
  segment: Segment = "global",
  runDate?: string,
  theme?: string,
): Promise<CompetitiveLandscape> {
  const themeScope = !theme || theme === COMPETITIVE_THEME_ALL ? null : theme;

  const dates = await runDatesDesc();
  if (dates.length === 0) return EMPTY_LANDSCAPE(segment, theme);
  const activeRunDate =
    runDate && dates.includes(runDate) ? runDate : (dates[0] as string);

  // The cohort and the active run's brand label are independent reads.
  const [raw, brandName] = await Promise.all([
    competitiveRows(),
    brandNameForRun(activeRunDate),
  ]);
  // Segment first; the theme options are read from the segment-scoped cohort so
  // the dropdown only ever offers themes that exist under the active segment.
  const inSegment = filterBySegment(raw, segment);
  const themes = [
    ...new Set(
      inSegment.map((r) => r.runTheme).filter((t): t is string => t !== null),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const scoped = filterByTheme(inSegment, themeScope);
  const trend = competitiveByRun(scoped);
  const fullSovTrend = shareOfVoiceTrend(trend);
  const currentFull = trend.find((p) => p.runDate === activeRunDate) ?? null;

  return {
    segment,
    theme: theme ?? COMPETITIVE_THEME_ALL,
    runDates: dates,
    themes,
    activeRunDate,
    current: currentFull ? capPoint(currentFull) : null,
    currentSovTotal: currentFull
      ? currentFull.shareOfVoice.competitors.length
      : 0,
    rankTrend: trend.map((p) => ({
      runDate: p.runDate,
      rankDistribution: p.rankDistribution,
    })),
    sovTrend: fullSovTrend.slice(0, SOV_TREND_LIMIT),
    sovTotal: fullSovTrend.length,
    // Brand SoV is computed off the same scoped cohort as every competitor's, and
    // ranked against the *uncapped* competitor list so "#3 of 27" is honest even
    // though only the top 10 competitors ship.
    brandSov: currentFull ? currentFull.brandSov : null,
    brandSovTrend: brandShareOfVoiceTrend(trend),
    brandSovRank: currentFull
      ? 1 +
        currentFull.shareOfVoice.competitors.filter(
          (c) => (c.share ?? 0) > (currentFull.brandSov.share ?? 0),
        ).length
      : null,
    brandName,
  };
}

// ── Cited view (issue #12) ───────────────────────────────────────────────────

/** The "all themes" sentinel for the cited view's theme scope (mirrors the
 * competitive view's COMPETITIVE_THEME_ALL). A concrete theme filters; this (or
 * absence) doesn't. */
export const CITED_THEME_ALL = "all";

/** How many owned URLs the focused-run breakdown ships. The owned-URL tail is
 * long across a run; the head carries the signal and `ownedUrlTotal` reports the
 * true distinct count so the UI can label the cap. */
export const OWNED_URL_LIMIT = 50;

/**
 * A reach-trend row as it leaves the DB: the trend input ({@link OwnedCitationRunRow}
 * — run date, error flag, owned-citation flag) plus the as-run classification the
 * segment/theme scope filters on. The generic {@link filterBySegment}/{@link
 * filterByTheme} preserve these extra fields, so the same scoped set feeds the
 * trend.
 */
interface OwnedReachQueryRow extends OwnedCitationRunRow {
  runBrandedType: string | null;
  runTheme: string | null;
}

/**
 * Every result across all runs with its error flag, owned-citation flag, and
 * as-run classification — the reach-trend input. LEFT JOIN to verdicts so a
 * result with no verdict (errored / join miss) still counts toward the All
 * denominator but never toward the Cited numerator (matching `headlineMetrics`).
 * The reach rate's denominator is the All cohort, so unlike the competitive
 * query this pulls *every* result, not just the cited subset.
 */
async function ownedReachRows(): Promise<OwnedReachQueryRow[]> {
  return db
    .select({
      runDate: results.runDate,
      hasError: results.hasError,
      ownedCited: verdicts.ownedCited,
      runBrandedType: results.runBrandedType,
      runTheme: results.runTheme,
    })
    .from(results)
    .leftJoin(verdicts, eq(verdicts.resultId, results.id));
}

/**
 * A focused-run owned-URL row as it leaves the DB: the per-URL breakdown input
 * ({@link OwnedUrlRow} — url, result id, provider) plus the as-run classification
 * for segment/theme scoping. Read from `verdict_owned_urls` joined to its result.
 * The Cited cohort is pinned explicitly (`verdicts.owned_cited = true`) rather
 * than left implicit: at ingest `ownedCitation.cited` and `ownedCitation.urls`
 * are independent judge fields, so a verdict could in principle carry owned URLs
 * with `cited = false` (or vice versa). The acceptance criterion is exactly
 * `owned_cited = true`, so the URL list and the reach numerator share that one
 * cohort definition — they can't disagree.
 */
interface OwnedUrlQueryRow extends OwnedUrlRow {
  runBrandedType: string | null;
  runTheme: string | null;
}

async function ownedUrlRowsForRun(
  runDate: string,
): Promise<OwnedUrlQueryRow[]> {
  return db
    .select({
      url: verdictOwnedUrls.url,
      resultId: verdictOwnedUrls.resultId,
      provider: results.provider,
      runBrandedType: results.runBrandedType,
      runTheme: results.runTheme,
    })
    .from(verdictOwnedUrls)
    .innerJoin(results, eq(results.id, verdictOwnedUrls.resultId))
    .innerJoin(verdicts, eq(verdicts.resultId, verdictOwnedUrls.resultId))
    .where(and(eq(results.runDate, runDate), eq(verdicts.ownedCited, true)));
}

export interface CitedView {
  segment: Segment;
  /** The active theme scope: CITED_THEME_ALL or a concrete theme. */
  theme: string;
  /** All ingested run dates, newest first (run switcher + context). */
  runDates: string[];
  /** Themes present in the Cited cohort within the segment (filter options). */
  themes: string[];
  /** The resolved active run (requested if real, else latest); null if no runs. */
  activeRunDate: string | null;
  /** The active run's owned-citation reach (cited / all), or null when no run
   * resolved or the active run has no results in scope. */
  current: OwnedCitationReach | null;
  /** Owned-citation reach per run, oldest→newest — the reach trend (line chart). */
  reachTrend: OwnedReachPoint[];
  /** The active run's owned URLs, most-cited first, capped to {@link OWNED_URL_LIMIT},
   * each with links back to the results that cited it. */
  ownedUrls: OwnedUrlAggregate[];
  /** Distinct owned URLs in scope before the cap, so the UI can say "top N of M". */
  ownedUrlTotal: number;
}

const EMPTY_CITED = (
  segment: Segment,
  theme: string | undefined,
): CitedView => ({
  segment,
  theme: theme ?? CITED_THEME_ALL,
  runDates: [],
  themes: [],
  activeRunDate: null,
  current: null,
  reachTrend: [],
  ownedUrls: [],
  ownedUrlTotal: 0,
});

/**
 * The Cited view (issue #12), scoped to a segment and (optionally) a theme. The
 * Cited cohort is `owned_cited = true` — "everywhere we show up". `reachTrend` is
 * the owned-citation rate per run date (ascending) over the All cohort (the
 * denominator the UI labels every share against), computed live. `current` is the
 * active run's reach (the requested run if real, else the latest). `ownedUrls` is
 * the active run's distinct owned URLs, most-cited first, each linking back to the
 * results that cited it. `themes` lists the themes present in the Cited cohort
 * *within the current segment* (the theme filter options); `runDates` is the full
 * newest-first run list (the run switcher).
 */
export async function citedView(
  segment: Segment = "global",
  runDate?: string,
  theme?: string,
): Promise<CitedView> {
  const themeScope = !theme || theme === CITED_THEME_ALL ? null : theme;

  const dates = await runDatesDesc();
  if (dates.length === 0) return EMPTY_CITED(segment, theme);
  const activeRunDate =
    runDate && dates.includes(runDate) ? runDate : (dates[0] as string);

  // Reach trend (all runs) and the focused run's owned URLs are independent
  // reads — fire them together.
  const [reachRaw, urlRaw] = await Promise.all([
    ownedReachRows(),
    ownedUrlRowsForRun(activeRunDate),
  ]);

  // Segment first; the theme options come from the Cited cohort (owned_cited =
  // true) within the segment, so the dropdown only offers themes where we
  // actually show up under the active segment.
  const inSegment = filterBySegment(reachRaw, segment);
  const themes = [
    ...new Set(
      inSegment
        .filter((r) => r.ownedCited === true)
        .map((r) => r.runTheme)
        .filter((t): t is string => t !== null),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const scoped = filterByTheme(inSegment, themeScope);
  const reachTrend = ownedCitationByRun(scoped);
  const current =
    reachTrend.find((p) => p.runDate === activeRunDate)?.reach ?? null;

  const urlsScoped = filterByTheme(
    filterBySegment(urlRaw, segment),
    themeScope,
  );
  const allUrls = ownedUrlsByFrequency(urlsScoped);

  return {
    segment,
    theme: theme ?? CITED_THEME_ALL,
    runDates: dates,
    themes,
    activeRunDate,
    current,
    reachTrend,
    ownedUrls: allUrls.slice(0, OWNED_URL_LIMIT),
    ownedUrlTotal: allUrls.length,
  };
}

// ── Prompt trajectory + prompt list (issue #13) ──────────────────────────────

/** The "all themes" sentinel for the prompt list's theme scope (mirrors the
 * competitive/cited views). A concrete theme filters; this (or absence) doesn't. */
export const PROMPT_THEME_ALL = "all";

/** How many prompts the list ships. The current era is 533 prompts; the cap is a
 * safety valve (and reported via `total` so the UI can label it) for a future
 * larger set, not a limit the current corpus hits. */
export const PROMPT_LIST_LIMIT = 600;

/**
 * One prompt's dedicated trajectory (issue #13): its identity/classification plus
 * a line per provider over every ingested run date. `runDates` is ascending (the
 * x-axis), spanning the whole corpus so a run where the prompt is *absent* shows
 * as a gap in each provider line, not a zero. `found` is false for an unknown
 * prompt id (a hand-typed URL), which the UI renders as a not-found state. The
 * prompt belongs to exactly one branded_type, so `segment` is carried only for
 * back-navigation context — it does not filter the prompt's own cells.
 */
export interface PromptTrajectory {
  found: boolean;
  promptId: string;
  text: string;
  theme: string | null;
  brandedType: string | null;
  isRelevant: boolean;
  location: string | null;
  /** Every ingested run date, ascending — the trajectory x-axis. */
  runDates: string[];
  /** One line per provider, each cell aligned to `runDates` (null = absent run). */
  providers: ProviderTrajectory[];
}

export async function promptTrajectory(
  promptId: string,
): Promise<PromptTrajectory> {
  const dates = await runDatesDesc();
  // Ascending: the trajectory reads left→right as time, and absent runs become
  // interior gaps rather than a truncated tail.
  const runOrder = [...dates].reverse();

  const [p] = await db
    .select({
      promptId: prompts.promptId,
      text: prompts.text,
      theme: prompts.theme,
      brandedType: prompts.brandedType,
      isRelevant: prompts.isRelevant,
      location: prompts.location,
    })
    .from(prompts)
    .where(eq(prompts.promptId, promptId))
    .limit(1);

  if (!p) {
    return {
      found: false,
      promptId,
      text: "",
      theme: null,
      brandedType: null,
      isRelevant: true,
      location: null,
      runDates: runOrder,
      providers: [],
    };
  }

  const rows = await db
    .select({
      runDate: results.runDate,
      provider: results.provider,
      resultId: results.id,
      hasError: results.hasError,
      mentioned: verdicts.mentioned,
      accuracyScore: verdicts.accuracyScore,
      ownedCited: verdicts.ownedCited,
      brandRank: verdicts.brandRank,
    })
    .from(results)
    .leftJoin(verdicts, eq(verdicts.resultId, results.id))
    .where(eq(results.promptId, promptId));

  return {
    found: true,
    promptId: p.promptId,
    text: p.text,
    theme: p.theme,
    brandedType: p.brandedType,
    isRelevant: p.isRelevant,
    location: p.location,
    runDates: runOrder,
    providers: promptTrajectoryByProvider(rows, runOrder),
  };
}

/** A prompt-mention row as it leaves the DB: the sparkline input
 * ({@link PromptSparkline} via {@link PromptMentionRow}) plus the as-run
 * classification the segment/theme scope filters on. */
interface PromptMentionQueryRow {
  promptId: string;
  runDate: string;
  hasError: boolean;
  mentioned: boolean | null;
  runBrandedType: string | null;
  runTheme: string | null;
}

/**
 * Every result across all runs with its prompt, error flag, mention flag, and
 * as-run classification — the prompt-list sparkline input. LEFT JOIN to verdicts
 * so an errored result still anchors the prompt's presence (it's excluded from
 * the mention rate downstream, never counted as a non-mention). Mirrors
 * {@link ownedReachRows}: the full corpus in memory (~tens of thousands of rows),
 * the established pattern for the trend views.
 */
async function promptMentionRows(): Promise<PromptMentionQueryRow[]> {
  return db
    .select({
      promptId: results.promptId,
      runDate: results.runDate,
      hasError: results.hasError,
      mentioned: verdicts.mentioned,
      runBrandedType: results.runBrandedType,
      runTheme: results.runTheme,
    })
    .from(results)
    .leftJoin(verdicts, eq(verdicts.resultId, results.id));
}

/** One row in the prompt list: identity + classification + a mention sparkline
 * aligned to the view's `runDates`. */
export interface PromptListItem {
  promptId: string;
  text: string;
  /** The as-run theme of the active run (the value the theme filter operates on),
   * so the Theme column and the filter agree; falls back to the dimension's
   * latest-seen theme only when the active run carries none. */
  theme: string | null;
  brandedType: string | null;
  /** Mention rate per run (pooled across providers), aligned to `runDates`;
   * null = absent that run (a gap). The list's per-row heat strip. */
  mentionRate: (number | null)[];
  /** Mention rate in the *active run* (the run the list is scoped to) — the
   * labeled row stat and default sort key; null if absent from that run. */
  activeRate: number | null;
}

/**
 * The prompt list (issue #13): every prompt present in the active run within the
 * segment/theme scope, each carrying a mention sparkline over the whole run
 * history so trends are scannable. Scoping mirrors the other views — segment via
 * the as-run `branded_type`, theme via the as-run `run_theme` *of the active run*
 * (which prompts to list); the sparkline itself spans every run (the trend). The
 * theme options come from the active run's segment-scoped cohort. Sorted by the
 * active run's mention rate ascending (lowest first — the prompts most worth a
 * look surface at the top), tie-broken by prompt text; the UI can re-sort.
 */
export interface PromptListView {
  segment: Segment;
  theme: string;
  /** Every ingested run date, ascending — the heat-strip x-axis. */
  runDates: string[];
  /** All ingested run dates, newest first (context / labeling). */
  runDatesDesc: string[];
  /** The resolved active run (requested if real, else latest); null if no runs. */
  activeRunDate: string | null;
  /** Index of the active run within `runDates` (ascending), or -1 if none — lets
   * the UI mark the active column in each row's heat strip. */
  activeRunIndex: number;
  /** Themes present in the active run within the segment (filter options). */
  themes: string[];
  prompts: PromptListItem[];
  /** Distinct prompts in scope before the cap, so the UI can say "N of M". */
  total: number;
}

const EMPTY_PROMPT_LIST = (
  segment: Segment,
  theme: string | undefined,
): PromptListView => ({
  segment,
  theme: theme ?? PROMPT_THEME_ALL,
  runDates: [],
  runDatesDesc: [],
  activeRunDate: null,
  activeRunIndex: -1,
  themes: [],
  prompts: [],
  total: 0,
});

export async function promptList(
  segment: Segment = "global",
  runDate?: string,
  theme?: string,
): Promise<PromptListView> {
  const themeScope = !theme || theme === PROMPT_THEME_ALL ? null : theme;

  const dates = await runDatesDesc();
  if (dates.length === 0) return EMPTY_PROMPT_LIST(segment, theme);
  const activeRunDate =
    runDate && dates.includes(runDate) ? runDate : (dates[0] as string);
  const runOrder = [...dates].reverse();
  const activeRunIndex = runOrder.indexOf(activeRunDate);

  // The sparkline rows (all runs) and the prompt dimension (533 rows: identity +
  // latest-seen classification, the list's display fields) are independent reads.
  const [mentionRaw, dim] = await Promise.all([
    promptMentionRows(),
    db
      .select({
        promptId: prompts.promptId,
        text: prompts.text,
        theme: prompts.theme,
        brandedType: prompts.brandedType,
      })
      .from(prompts),
  ]);

  const inSegment = filterBySegment(mentionRaw, segment);

  // Theme options + the listable set both read from the active run within the
  // segment, so the dropdown only offers themes that exist there and a theme
  // filter narrows the *list* (not the per-row sparkline, which spans all runs).
  const activeRows = inSegment.filter((r) => r.runDate === activeRunDate);
  const themes = [
    ...new Set(
      activeRows.map((r) => r.runTheme).filter((t): t is string => t !== null),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const listable = new Set(
    filterByTheme(activeRows, themeScope).map((r) => r.promptId),
  );
  // The theme the list *filters on* is the as-run `run_theme` of the active run,
  // so the Theme column shows that same value (not the dimension's latest-seen
  // `prompts.theme`, which can disagree) — the column and the filter never read
  // differently. Falls back to the dimension theme only when the active run
  // carries no theme for the prompt.
  const activeThemeByPrompt = new Map(
    activeRows.map((r) => [r.promptId, r.runTheme] as const),
  );

  // Sparklines over the segment-scoped rows (all runs), then keep the listable
  // set. Computing for the whole segment and filtering after is the same in-memory
  // pass the other views use.
  const sparkByPrompt = new Map(
    promptSparklines(inSegment, runOrder).map((s) => [s.promptId, s]),
  );
  const dimByPrompt = new Map(dim.map((d) => [d.promptId, d]));

  const items: PromptListItem[] = [...listable]
    .map((promptId) => {
      const d = dimByPrompt.get(promptId);
      const s = sparkByPrompt.get(promptId);
      const mentionRate = s?.mentionRate ?? runOrder.map(() => null);
      return {
        promptId,
        text: d?.text ?? promptId,
        theme: activeThemeByPrompt.get(promptId) ?? d?.theme ?? null,
        brandedType: d?.brandedType ?? null,
        mentionRate,
        activeRate:
          activeRunIndex >= 0 ? (mentionRate[activeRunIndex] ?? null) : null,
      };
    })
    .sort((a, b) => {
      // Lowest active-run mention rate first (most worth a look); a prompt absent
      // from the active run (null) sorts last. Tie-break by text for stability.
      const ar = a.activeRate;
      const br = b.activeRate;
      if (ar == null && br == null) return a.text.localeCompare(b.text);
      if (ar == null) return 1;
      if (br == null) return -1;
      return ar !== br ? ar - br : a.text.localeCompare(b.text);
    });

  return {
    segment,
    theme: theme ?? PROMPT_THEME_ALL,
    runDates: runOrder,
    runDatesDesc: dates,
    activeRunDate,
    activeRunIndex,
    themes,
    prompts: items.slice(0, PROMPT_LIST_LIMIT),
    total: items.length,
  };
}
