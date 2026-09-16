// Context builder for the learnings layer. Pure, LLM-free functions that turn a
// run's `comparison-<date>.json` into the compact structured input a tier-1
// generator consumes. Kept deterministic so it can be unit-tested without an LLM.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResultDelta, WeekComparison } from "../analytics/types.js";
import type {
  CompetitorMove,
  MetricMove,
  MoverTallies,
  MoversContext,
  NotableExample,
} from "./types.js";

/** How many competitor moves to surface in each direction. */
const TOP_COMPETITORS = 5;
/** Cap on grounding examples, and per-kind cap, to keep the prompt focused. */
const MAX_EXAMPLES = 8;
const MAX_PER_KIND = 2;

/** Load a run's comparison file. Throws if absent (caller surfaces the error). */
export async function loadComparison(
  outputDir: string,
  date: string,
): Promise<WeekComparison> {
  const path = join(outputDir, `comparison-${date}.json`);
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as WeekComparison;
}

function delta(prev: number | null, curr: number | null): number | null {
  return prev !== null && curr !== null ? curr - prev : null;
}

function buildMetrics(comparison: WeekComparison): MetricMove[] {
  const s = comparison.summary;
  return [
    {
      metric: "mentions",
      label: "Results mentioning the brand",
      prev: s.mentionedCount.prev,
      curr: s.mentionedCount.curr,
      delta: s.mentionedCount.curr - s.mentionedCount.prev,
    },
    {
      metric: "avgAccuracy",
      label: "Average description accuracy (1-5)",
      prev: s.avgAccuracy.prev,
      curr: s.avgAccuracy.curr,
      delta: delta(s.avgAccuracy.prev, s.avgAccuracy.curr),
    },
    {
      metric: "ownedCitations",
      label: "Results citing an owned domain",
      prev: s.ownedCitationCount.prev,
      curr: s.ownedCitationCount.curr,
      delta: s.ownedCitationCount.curr - s.ownedCitationCount.prev,
    },
    {
      metric: "primaryRank",
      label: "Results ranking the brand #1",
      prev: s.primaryRankCount.prev,
      curr: s.primaryRankCount.curr,
      delta: s.primaryRankCount.curr - s.primaryRankCount.prev,
    },
  ];
}

function buildCompetitorMoves(comparison: WeekComparison): {
  gaining: CompetitorMove[];
  losing: CompetitorMove[];
} {
  const moves: CompetitorMove[] = Object.entries(
    comparison.summary.competitorCounts,
  ).map(([name, { prev, curr }]) => ({ name, prev, curr, delta: curr - prev }));

  // Rank by signed delta; ties broken by name for deterministic output.
  const gaining = moves
    .filter((m) => m.delta > 0)
    .sort((a, b) => b.delta - a.delta || a.name.localeCompare(b.name))
    .slice(0, TOP_COMPETITORS);
  const losing = moves
    .filter((m) => m.delta < 0)
    .sort((a, b) => a.delta - b.delta || a.name.localeCompare(b.name))
    .slice(0, TOP_COMPETITORS);

  return { gaining, losing };
}

function buildTallies(deltas: ResultDelta[]): MoverTallies {
  const t: MoverTallies = {
    newMentions: 0,
    lostMentions: 0,
    gainedOwnedCitations: 0,
    lostOwnedCitations: 0,
    ranksImproved: 0,
    accuracyGains: 0,
    accuracyDrops: 0,
  };
  for (const d of deltas) {
    if (d.newMention) t.newMentions++;
    if (d.lostMention) t.lostMentions++;
    if (d.gainedOwnedCitation) t.gainedOwnedCitations++;
    if (d.lostOwnedCitation) t.lostOwnedCitations++;
    if (d.rankImproved) t.ranksImproved++;
    if (d.accuracyDelta !== null && d.accuracyDelta > 0) t.accuracyGains++;
    if (d.accuracyDelta !== null && d.accuracyDelta < 0) t.accuracyDrops++;
  }
  return t;
}

function classify(d: ResultDelta): NotableExample | null {
  if (d.newMention)
    return {
      ...loc(d),
      kind: "newMention",
      detail: "Newly mentioned this run",
    };
  if (d.lostMention)
    return {
      ...loc(d),
      kind: "lostMention",
      detail: "Lost a mention it had last run",
    };
  if (d.rankImproved)
    return {
      ...loc(d),
      kind: "rankImproved",
      detail: `Brand rank improved (${d.prevRank ?? "n/a"} → ${d.currRank})`,
    };
  if (d.gainedOwnedCitation)
    return {
      ...loc(d),
      kind: "gainedOwnedCitation",
      detail: "Gained an owned-domain citation",
    };
  if (d.lostOwnedCitation)
    return {
      ...loc(d),
      kind: "lostOwnedCitation",
      detail: "Lost an owned-domain citation",
    };
  if (d.accuracyDelta !== null && d.accuracyDelta > 0)
    return {
      ...loc(d),
      kind: "accuracyGain",
      detail: `Description accuracy ${d.prevAccuracy} → ${d.currAccuracy}`,
    };
  if (d.accuracyDelta !== null && d.accuracyDelta < 0)
    return {
      ...loc(d),
      kind: "accuracyDrop",
      detail: `Description accuracy ${d.prevAccuracy} → ${d.currAccuracy}`,
    };
  return null;
}

function loc(
  d: ResultDelta,
): Pick<NotableExample, "prompt" | "provider" | "model"> {
  return { prompt: d.prompt, provider: d.provider, model: d.model };
}

/**
 * Pick up to MAX_EXAMPLES grounding examples, capping each kind at MAX_PER_KIND
 * so a single dominant signal can't crowd out the rest. Deterministic: examples
 * are drawn in the comparison's existing delta order.
 */
function buildNotableExamples(deltas: ResultDelta[]): NotableExample[] {
  const perKind = new Map<NotableExample["kind"], number>();
  const out: NotableExample[] = [];
  for (const d of deltas) {
    if (out.length >= MAX_EXAMPLES) break;
    const ex = classify(d);
    if (!ex) continue;
    const seen = perKind.get(ex.kind) ?? 0;
    if (seen >= MAX_PER_KIND) continue;
    perKind.set(ex.kind, seen + 1);
    out.push(ex);
  }
  return out;
}

/**
 * Distill a week-over-week comparison into the Movers generator's input. Pure:
 * same comparison in → same context out.
 */
export function buildMoversContext(
  comparison: WeekComparison,
  source: string,
): MoversContext {
  const { gaining, losing } = buildCompetitorMoves(comparison);
  return {
    currentDate: comparison.currentDate,
    previousDate: comparison.previousDate,
    totalResults: comparison.summary.totalResults,
    source,
    metrics: buildMetrics(comparison),
    topGainingCompetitors: gaining,
    topLosingCompetitors: losing,
    tallies: buildTallies(comparison.deltas),
    notableExamples: buildNotableExamples(comparison.deltas),
  };
}
