// Shared data-contract types (AnalyticsConfig family, ResultVerdict family) now
// live in @aio/core; re-export them so existing `./types.js` imports stay valid.
export * from "@aio/core";

import type { BrandRank } from "@aio/core";

// --- Phase 2: Week-over-week delta (pipeline-internal analysis output) ---
// Note: the dashboard computes its own deltas live from the DB and does not
// consume these types, so they stay in the pipeline.

export interface ResultDelta {
  prompt: string;
  provider: string;
  model: string;
  newMention: boolean;
  lostMention: boolean;
  prevAccuracy: number | null;
  currAccuracy: number | null;
  accuracyDelta: number | null;
  gainedOwnedCitation: boolean;
  lostOwnedCitation: boolean;
  prevRank: BrandRank | null;
  currRank: BrandRank;
  rankImproved: boolean;
  newCompetitors: string[];
  departedCompetitors: string[];
  mentionHypothesis: string | null;
}

export interface WeekComparisonSummary {
  totalResults: number;
  mentionedCount: { prev: number; curr: number };
  avgAccuracy: { prev: number | null; curr: number | null };
  ownedCitationCount: { prev: number; curr: number };
  primaryRankCount: { prev: number; curr: number };
  competitorCounts: Record<string, { prev: number; curr: number }>;
}

export interface WeekComparison {
  currentDate: string;
  previousDate: string;
  deltas: ResultDelta[];
  summary: WeekComparisonSummary;
}
