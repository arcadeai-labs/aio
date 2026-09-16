// Internal, LLM-free input shapes for the learnings layer. The dashboard does
// not consume these — they exist only to feed focused generator prompts, so
// they stay in the pipeline (mirroring analytics/types.ts).

import type {
  LearningConfidence,
  LearningEvidence,
  LearningStatus,
} from "@aio/core";

/** An aggregate week-over-week move on one headline metric. */
export interface MetricMove {
  metric: "mentions" | "avgAccuracy" | "ownedCitations" | "primaryRank";
  label: string;
  prev: number | null;
  curr: number | null;
  delta: number | null;
}

/** A single competitor's week-over-week mention-count move. */
export interface CompetitorMove {
  name: string;
  prev: number;
  curr: number;
  delta: number;
}

/** A concrete per-result delta worth citing as a grounding example. */
export interface NotableExample {
  prompt: string;
  provider: string;
  model: string;
  kind:
    | "newMention"
    | "lostMention"
    | "gainedOwnedCitation"
    | "lostOwnedCitation"
    | "rankImproved"
    | "accuracyGain"
    | "accuracyDrop";
  detail: string;
}

/** Signed tallies of per-result events ("wins" vs. "blockers"). */
export interface MoverTallies {
  newMentions: number;
  lostMentions: number;
  gainedOwnedCitations: number;
  lostOwnedCitations: number;
  ranksImproved: number;
  accuracyGains: number;
  accuracyDrops: number;
}

/**
 * The compact, deterministic distillation of `comparison-<date>.json` that the
 * Movers generator consumes. Built purely (no LLM): the raw comparison can carry
 * thousands of per-result deltas, so this rolls them up into headline metric
 * moves, top competitor moves, signed tallies, and a handful of grounding
 * examples.
 */
export interface MoversContext {
  currentDate: string;
  previousDate: string;
  totalResults: number;
  /** Filename the metrics were drawn from, used as evidence `source`. */
  source: string;
  metrics: MetricMove[];
  topGainingCompetitors: CompetitorMove[];
  topLosingCompetitors: CompetitorMove[];
  tallies: MoverTallies;
  notableExamples: NotableExample[];
}

/** Shape a structured (tier-1) generator's LLM call returns, pre-provenance. */
export interface StructuredLearningDraft {
  status: LearningStatus;
  headline: string;
  body: string;
  evidence: LearningEvidence[];
  confidence: LearningConfidence;
}
