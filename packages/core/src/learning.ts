// Per-run learning record: a short, grounded interpretation of a weekly run
// ("headline + body + cited evidence + confidence"), not a metrics dump.
//
// Learnings are run-scoped snapshots, frozen once written. Each generator in the
// learnings registry produces exactly one record per run, landing in a
// predictable slot (one JSON file per slug). Shared data contract between the
// pipeline (writer), ingest, and the dashboard (reader) — lives in core for the
// same reason ResultVerdict does.

export type LearningTier = "structured" | "agentic";

/**
 * - `ok`: a real finding, grounded in evidence.
 * - `nothing_notable`: the generator ran but found nothing worth surfacing
 *   (preferred over fabricating a finding).
 * - `unavailable`: the generator failed or timed out; the slot degrades rather
 *   than failing the run.
 */
export type LearningStatus = "ok" | "nothing_notable" | "unavailable";

export type LearningConfidence = "low" | "medium" | "high";

/**
 * A single cited datum backing a learning. `value` and `delta` are kept as the
 * raw scalar from the source (number for metrics, string for labels) so the
 * dashboard can render them verbatim without re-deriving anything.
 */
export interface LearningEvidence {
  label: string;
  value: string | number;
  delta?: string | number;
  /** Where the datum came from, e.g. `comparison-2026-06-22.json`. */
  source: string;
}

export interface Learning {
  /** Stable catalog key, e.g. `movers`. One file per slug per run. */
  slug: string;
  tier: LearningTier;
  /** The run this learning interprets, `YYYY-MM-DD`. */
  runDate: string;
  status: LearningStatus;
  headline: string;
  body: string;
  evidence: LearningEvidence[];
  confidence: LearningConfidence;
  /** Model / version provenance, e.g. `movers@openai:gpt-5.2`. */
  generator: string;
  /** ISO timestamp the record was produced. */
  generatedAt: string;
}

export const LEARNING_TIERS: readonly LearningTier[] = [
  "structured",
  "agentic",
];

export const LEARNING_STATUSES: readonly LearningStatus[] = [
  "ok",
  "nothing_notable",
  "unavailable",
];

export const LEARNING_CONFIDENCES: readonly LearningConfidence[] = [
  "low",
  "medium",
  "high",
];
