// Pure transform: parsed JSONL records + config → normalized row sets ready for
// the DB writer. No I/O, no DB — every load-time hygiene rule lives here so it
// can be unit-tested against small fixtures (see DASHBOARD_SPEC.md §5):
//
//   - analysis deduped by resultId (keep latest analyzedAt)
//   - competitor enum filtered to mentioned=true (only those rows are stored)
//   - verdicts whose resultId has no matching result are skipped + flagged
//   - only structured fields are carried (raw provider payloads are dropped)

import type { AnalyticsConfig, ResultVerdict, UnifiedResult } from "@aio/core";
import {
  promptId as hashPromptId,
  normalizeBrandedType,
  parseLabels,
} from "./normalize.js";

// Row shapes mirror the Drizzle schema (camelCase keys = column keys). Kept as
// plain objects so the transform stays DB-agnostic and testable.

export interface PromptRow {
  promptId: string;
  text: string;
  normalizedText: string;
  theme: string | null;
  brandedType: string | null;
  isRelevant: boolean;
  location: string | null;
  firstSeenRun: string;
  lastSeenRun: string;
}

export interface PromptLabelRow {
  promptId: string;
  label: string;
}

export interface ResultRow {
  id: string;
  runDate: string;
  promptId: string;
  provider: string;
  model: string;
  responseText: string;
  searchTool: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  hasError: boolean;
  runBrandedType: string | null;
  runTheme: string | null;
  rawRef: string | null;
}

export interface SearchQueryRow {
  resultId: string;
  query: string;
  ts: Date | null;
}

export interface SearchResultRow {
  resultId: string;
  url: string;
  title: string | null;
  snippet: string | null;
  score: number | null;
  pageDate: string | null;
}

export interface CitationRow {
  resultId: string;
  url: string;
  title: string | null;
  citedText: string | null;
  startIndex: number | null;
  endIndex: number | null;
}

export interface VerdictRow {
  resultId: string;
  promptId: string;
  provider: string;
  model: string;
  mentioned: boolean;
  mentionCount: number;
  accuracyScore: number | null;
  accuracyReasoning: string | null;
  ownedCited: boolean;
  othersPresent: boolean;
  othersCount: number;
  brandRank: string;
  mentionHypothesis: string | null;
  analyzedAt: Date | null;
  judgeModel: string | null;
  judgeInputTokens: number | null;
  judgeOutputTokens: number | null;
}

export interface VerdictExcerptRow {
  resultId: string;
  excerpt: string;
}

export interface VerdictOwnedUrlRow {
  resultId: string;
  url: string;
}

export interface CompetitorMentionRow {
  resultId: string;
  competitorName: string;
}

export interface CompetitorCitedUrlRow {
  resultId: string;
  competitorName: string;
  url: string;
}

export interface ConfigSnapshot {
  runDate: string;
  brandName: string;
  groundTruthDescription: string | null;
  judgeProvider: string | null;
  judgeModel: string | null;
  raw: unknown;
  ownedDomains: string[];
  competitors: string[];
  aliases: string[];
}

export interface RunBundle {
  runDate: string;
  prompts: PromptRow[];
  promptLabels: PromptLabelRow[];
  results: ResultRow[];
  searchQueries: SearchQueryRow[];
  searchResults: SearchResultRow[];
  citations: CitationRow[];
  verdicts: VerdictRow[];
  verdictExcerpts: VerdictExcerptRow[];
  verdictOwnedUrls: VerdictOwnedUrlRow[];
  competitorMentions: CompetitorMentionRow[];
  competitorCitedUrls: CompetitorCitedUrlRow[];
  config: ConfigSnapshot | null;
  // Provenance: verdicts dropped because no matching result was in this run.
  orphanVerdictIds: string[];
}

function toDate(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Postgres text columns reject \x00; strip null bytes from external content.
function sanitize(s: string): string;
function sanitize(s: string | null): string | null;
function sanitize(s: string | null): string | null {
  if (s == null) return null;
  return s.indexOf("\0") === -1 ? s : s.replaceAll("\0", "");
}

/**
 * Dedupe verdicts by resultId, keeping the one with the latest `analyzedAt`.
 * The pipeline can re-judge a result within a run; only the freshest verdict
 * should land. Exported for direct testing.
 */
export function dedupeVerdicts(verdicts: ResultVerdict[]): ResultVerdict[] {
  const latest = new Map<string, ResultVerdict>();
  for (const v of verdicts) {
    const existing = latest.get(v.resultId);
    if (!existing) {
      latest.set(v.resultId, v);
      continue;
    }
    // Compare analyzedAt; missing/invalid timestamps sort oldest.
    const t = Date.parse(v.analyzedAt ?? "");
    const tExisting = Date.parse(existing.analyzedAt ?? "");
    const newer =
      (Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t) >=
      (Number.isNaN(tExisting) ? Number.NEGATIVE_INFINITY : tExisting);
    if (newer) latest.set(v.resultId, v);
  }
  return [...latest.values()];
}

/**
 * Build the full normalized row bundle for one dated run from its parsed
 * results + verdicts and the effective config. Pure: same inputs → same bundle.
 */
export function buildRunBundle(args: {
  runDate: string;
  results: UnifiedResult[];
  verdicts: ResultVerdict[];
  config?: AnalyticsConfig | null;
}): RunBundle {
  const { runDate, results, config } = args;

  // ── Prompts dimension (within this run; latest-seen across runs is resolved
  // at write time). Keyed by prompt_id; first/last seen are this run's date.
  const promptMap = new Map<string, PromptRow>();
  const labelSet = new Set<string>(); // `${promptId}\0${label}` dedupe
  const promptLabels: PromptLabelRow[] = [];

  const resultRows: ResultRow[] = [];
  const searchQueries: SearchQueryRow[] = [];
  const searchResults: SearchResultRow[] = [];
  const citations: CitationRow[] = [];
  const knownResultIds = new Set<string>();

  for (const r of results) {
    const pid = hashPromptId(r.prompt);
    const meta = r.promptMeta ?? {};
    const brandedType = normalizeBrandedType(meta.brandedType);
    const theme = r.promptCategory ?? null;

    if (!promptMap.has(pid)) {
      promptMap.set(pid, {
        promptId: pid,
        text: r.prompt,
        normalizedText: r.prompt.trim().replace(/\s+/g, " ").toLowerCase(),
        theme,
        brandedType,
        isRelevant: true,
        location: meta.location ?? null,
        firstSeenRun: runDate,
        lastSeenRun: runDate,
      });
      for (const label of parseLabels(meta.labels)) {
        const key = `${pid}\0${label}`;
        if (!labelSet.has(key)) {
          labelSet.add(key);
          promptLabels.push({ promptId: pid, label });
        }
      }
    }

    knownResultIds.add(r.id);
    const hasError = r.error != null;
    resultRows.push({
      id: r.id,
      runDate,
      promptId: pid,
      provider: r.metadata?.provider ?? "",
      model: r.metadata?.model ?? "",
      responseText: sanitize(r.responseText ?? ""),
      searchTool: r.metadata?.searchTool ?? null,
      startedAt: toDate(r.metadata?.startedAt),
      completedAt: toDate(r.metadata?.completedAt),
      latencyMs: r.metadata?.latencyMs ?? null,
      inputTokens: r.metadata?.tokenUsage?.inputTokens ?? null,
      outputTokens: r.metadata?.tokenUsage?.outputTokens ?? null,
      estimatedCostUsd: r.metadata?.estimatedCostUsd ?? null,
      errorCode: r.error?.code ?? null,
      errorMessage: r.error?.message ?? null,
      hasError,
      runBrandedType: brandedType,
      runTheme: theme,
      rawRef: null,
    });

    for (const q of r.searchQueries ?? []) {
      searchQueries.push({
        resultId: r.id,
        query: q.query,
        ts: toDate(q.timestamp),
      });
    }
    for (const s of r.searchResults ?? []) {
      searchResults.push({
        resultId: r.id,
        url: s.url,
        title: sanitize(s.title ?? null),
        snippet: sanitize(s.snippet ?? null),
        score: s.score ?? null,
        pageDate: s.pageDate ?? null,
      });
    }
    for (const c of r.citations ?? []) {
      citations.push({
        resultId: r.id,
        url: c.url,
        title: sanitize(c.title ?? null),
        citedText: sanitize(c.citedText ?? null),
        startIndex: c.startIndex ?? null,
        endIndex: c.endIndex ?? null,
      });
    }
  }

  // ── Verdicts: dedupe by resultId (latest analyzedAt), then drop orphans.
  const verdicts: VerdictRow[] = [];
  const verdictExcerpts: VerdictExcerptRow[] = [];
  const verdictOwnedUrls: VerdictOwnedUrlRow[] = [];
  const competitorMentions: CompetitorMentionRow[] = [];
  const competitorCitedUrls: CompetitorCitedUrlRow[] = [];
  const orphanVerdictIds: string[] = [];

  for (const v of dedupeVerdicts(args.verdicts)) {
    if (!knownResultIds.has(v.resultId)) {
      orphanVerdictIds.push(v.resultId);
      continue;
    }
    verdicts.push({
      resultId: v.resultId,
      promptId: hashPromptId(v.prompt),
      provider: v.provider,
      model: v.model,
      mentioned: v.brandMention.mentioned,
      mentionCount: v.brandMention.mentionCount ?? 0,
      accuracyScore: v.descriptionAccuracy?.score ?? null,
      accuracyReasoning: sanitize(v.descriptionAccuracy?.reasoning ?? null),
      ownedCited: v.ownedCitation.cited,
      othersPresent: v.competitivePosition.othersPresent,
      othersCount: v.competitivePosition.othersCount ?? 0,
      brandRank: String(v.competitivePosition.brandRank),
      mentionHypothesis: v.mentionHypothesis ?? null,
      analyzedAt: toDate(v.analyzedAt),
      judgeModel: v.judgeModel ?? null,
      judgeInputTokens: v.judgeTokens?.input ?? null,
      judgeOutputTokens: v.judgeTokens?.output ?? null,
    });

    for (const excerpt of v.brandMention.excerpts ?? []) {
      verdictExcerpts.push({
        resultId: v.resultId,
        excerpt: sanitize(excerpt),
      });
    }
    for (const url of v.ownedCitation.urls ?? []) {
      verdictOwnedUrls.push({ resultId: v.resultId, url });
    }
    // Only mentioned=true competitors are stored (the source lists every
    // competitor on every row).
    for (const comp of v.competitivePosition.competitors ?? []) {
      if (!comp.mentioned) continue;
      competitorMentions.push({
        resultId: v.resultId,
        competitorName: comp.name,
      });
      for (const url of comp.citedUrls ?? []) {
        competitorCitedUrls.push({
          resultId: v.resultId,
          competitorName: comp.name,
          url,
        });
      }
    }
  }

  return {
    runDate,
    prompts: [...promptMap.values()],
    promptLabels,
    results: resultRows,
    searchQueries,
    searchResults,
    citations,
    verdicts,
    verdictExcerpts,
    verdictOwnedUrls,
    competitorMentions,
    competitorCitedUrls,
    config: config ? buildConfigSnapshot(runDate, config) : null,
    orphanVerdictIds,
  };
}

function buildConfigSnapshot(
  runDate: string,
  config: AnalyticsConfig,
): ConfigSnapshot {
  return {
    runDate,
    brandName: config.brand.name,
    groundTruthDescription: config.brand.groundTruthDescription ?? null,
    judgeProvider: config.judgeModel?.provider ?? null,
    judgeModel: config.judgeModel?.model ?? null,
    raw: config,
    ownedDomains: config.brand.ownedDomains ?? [],
    competitors: config.brand.knownCompetitors ?? [],
    aliases: config.brand.aliases ?? [],
  };
}
