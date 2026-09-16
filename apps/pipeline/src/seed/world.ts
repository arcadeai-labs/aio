// The world model behind `bun run seed`: fifteen weeks in the life of a brand,
// expressed as numbers. `scenario.ts` renders records; this file decides what
// those records should say, and `prose.ts` decides how they say it.
//
// It exists as its own module because the six behaviours the corpus has to
// demonstrate are a product decision, not an implementation detail. Every dial
// below is named, and every one of them is readable off the rendered dashboard:
//
//   1. a large, sustained branded/unbranded gap      BRANDED_/UNBRANDED_MENTION_RATE
//   2. a description-accuracy recovery                ACCURACY_FLOOR → ACCURACY_CEILING
//   3. a competitor overtake                          COMPETITOR_CURVES[RISER_CURVE_INDEX]
//   4. one provider failing for exactly one week      outageWeekIndex / outageTargetIndex
//   5. a visibly narrowing cohort funnel              OWNED_CITATION_BASE against the above
//   6. divergence between providers                   PROVIDER_PROFILES
//
// Not every quantity improves, on purpose: the 1st-place rate ends the series
// well below where it started, because a reader most needs to be able to read a
// decline and an interface that only ever renders gains never proves it can.
//
// PURITY CONTRACT (asserted by apps/pipeline/test/seed-scenario.test.ts):
// the import block below is the whole of this module's outside world. No
// `node:fs`, no `node:path`, no network client, no `Date.now()`, no
// `Math.random()`. Every value that varies comes from the injected `Rng`.
import type { Rng } from "./rng.js";

/** Which half of the prompt set a prompt belongs to — the dashboard's primary segment. */
export type PromptKind = "branded" | "unbranded";

// ── Position in the series ──────────────────────────────────────────────────

/**
 * Where a run sits in the arc: 0 at the oldest run, 1 at the newest. Every
 * curve below is a function of this rather than of a week number, so the same
 * story plays out whether the corpus is 15 weeks or 6.
 */
export function seriesPosition(weekIndex: number, weeks: number): number {
  return weeks <= 1 ? 1 : weekIndex / (weeks - 1);
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** Hermite ease between two edges: 0 below `edge0`, 1 above `edge1`, smooth between. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** The shared S-curve most of the world's drift rides on. */
function ramp(t: number): number {
  return smoothstep(0.08, 0.92, t);
}

// ── 1. The branded / unbranded gap ──────────────────────────────────────────
// The single largest signal in the corpus, and the reason the segment selector
// exists. It does not move across the series: a gap that drifted would be read
// as the story, and the story is elsewhere.

export const BRANDED_MENTION_RATE = 0.9;
export const UNBRANDED_MENTION_RATE = 0.1;

export function mentionChance(
  kind: PromptKind,
  profile: ProviderProfile,
): number {
  return kind === "branded"
    ? clamp(BRANDED_MENTION_RATE * profile.mention, 0.4, 0.99)
    : // The same tilt applied to a rate this low would be invisible, so
      // provider divergence is widened here rather than flattened.
      clamp(
        UNBRANDED_MENTION_RATE * (1 + (profile.mention - 1) * 3),
        0.01,
        0.4,
      );
}

// ── 2. The description-accuracy recovery ────────────────────────────────────
// Flat and poor for the first fifth, climbing through the middle, settled by
// the last quarter. Model knowledge moves on the timescale of a quarter, which
// is why the corpus is a quarter long; a recovery drawn over three weeks would
// teach a reader to expect feedback they will never get.

export const ACCURACY_FLOOR = 2.5;
export const ACCURACY_CEILING = 4.75;

export function accuracyMean(t: number, profile: ProviderProfile): number {
  const arc =
    ACCURACY_FLOOR +
    (ACCURACY_CEILING - ACCURACY_FLOOR) * smoothstep(0.2, 0.74, t);
  return clamp(arc + profile.accuracy, 1.1, 4.9);
}

/**
 * One judge score around `mean`. Three uniforms summed give a roughly
 * triangular spread (sd ≈ 0.9 of a point) so a week's scores vary the way real
 * judgements do while the cohort mean tracks the arc above.
 */
export function sampleAccuracy(mean: number, rng: Rng): 1 | 2 | 3 | 4 | 5 {
  const noise = (rng.next() + rng.next() + rng.next() - 1.5) * 1.8;
  return clamp(Math.round(mean + noise), 1, 5) as 1 | 2 | 3 | 4 | 5;
}

export type AccuracyTier = "low" | "mixed" | "high";

/** The band a score falls in, which is what the prose is written against. */
export function accuracyTier(score: number): AccuracyTier {
  return score <= 2 ? "low" : score === 3 ? "mixed" : "high";
}

// ── 3. The competitor overtake ──────────────────────────────────────────────
// Each competitor gets a base rate and a drift across the series. Index 2 — in
// the shipped config, TickTick — is the riser: it starts well behind the brand
// and ends well ahead of it, which is what puts a crossover on the competitive
// chart instead of a static ordering. Index 0 is the incumbent leader, ceding
// ground slowly. Curves are assigned by position in `knownCompetitors`, so the
// story survives a forker swapping the names.

interface CompetitorCurve {
  base: number;
  drift: number;
}

const COMPETITOR_CURVES: readonly CompetitorCurve[] = [
  { base: 0.56, drift: -0.16 }, // 0 — the incumbent, slowly ceding
  { base: 0.3, drift: -0.05 }, // 1
  { base: 0.14, drift: 0.54 }, // 2 — THE RISER
  { base: 0.25, drift: 0.03 }, // 3
  { base: 0.22, drift: -0.08 }, // 4
  { base: 0.16, drift: 0.04 }, // 5
  { base: 0.19, drift: -0.02 }, // 6
  { base: 0.13, drift: 0.05 }, // 7
];

const RISER_CURVE_INDEX = 2;

/** Which entry of `knownCompetitors` carries the overtake. */
export function riserIndex(competitorCount: number): number {
  return Math.min(RISER_CURVE_INDEX, Math.max(0, competitorCount - 1));
}

export function competitorChance(
  competitorIndex: number,
  t: number,
  profile: ProviderProfile,
): number {
  const curve = COMPETITOR_CURVES[competitorIndex % COMPETITOR_CURVES.length];
  return clamp(
    (curve.base + curve.drift * ramp(t)) * profile.competitor,
    0.02,
    0.95,
  );
}

/**
 * Past this point the riser is the name the write-ups open with, so the prose
 * changes and the brand stops taking first place. Tuned to land where the
 * measured share-of-voice curves actually cross — the chart and the sentences
 * have to agree, or a reader gets a flat contradiction in the excerpts.
 */
const RISER_AHEAD_FROM = 0.5;

export function riserIsAhead(t: number): boolean {
  return t >= RISER_AHEAD_FROM;
}

/**
 * P(brand takes first place | it was mentioned in a competitive answer). Falls
 * across the series: this is the quantity that ends worse than it started.
 */
export function brandTopChance(t: number): number {
  return 0.68 + (0.32 - 0.68) * ramp(t);
}

// ── 4. The one-week provider outage ─────────────────────────────────────────
// Exactly one (provider, week) pair errors, and nothing else in the corpus
// does. A scatter of random flakes would make the same point statistically and
// prove nothing legibly: this way the exclusion of errored results from every
// cohort and denominator is a thing you can point at on the screen — that
// provider's row for that week has no denominator at all, and the pooled
// headline does not dip.

/** The outage lands about three-fifths of the way along, clear of both ends. */
export function outageWeekIndex(weeks: number): number {
  return weeks <= 1 ? 0 : Math.min(weeks - 1, Math.round((weeks - 1) * 0.6));
}

/**
 * The last target in the matrix. Chosen by position rather than by name so a
 * forker who edits `DEFAULT_TARGETS` still gets exactly one outage; with the
 * shipped matrix that is `exa`.
 */
export function outageTargetIndex(targetCount: number): number {
  return targetCount - 1;
}

// ── 5. The cohort funnel ────────────────────────────────────────────────────
// All ≫ Mentioned ≫ Cited. `Mentioned` narrows out of `All` because unbranded
// prompts rarely name the brand; `Cited` narrows out of `Mentioned` because an
// owned page is only cited when the answer named us. Owned citations track
// accuracy: an answer that read the official site describes the product
// correctly, so the two rise together and the funnel keeps its shape.

const OWNED_CITATION_BASE = 0.3;

const OWNED_BY_ACCURACY: Record<AccuracyTier, number> = {
  low: 0.4,
  mixed: 1,
  high: 1.4,
};

export function ownedCitationChance(
  tier: AccuracyTier,
  profile: ProviderProfile,
): number {
  return clamp(
    OWNED_CITATION_BASE * OWNED_BY_ACCURACY[tier] * profile.owned,
    0.02,
    0.9,
  );
}

// ── 6. Divergence between providers ─────────────────────────────────────────
// Six near-identical rows would make the per-provider breakdown decorative.
// The ladder is deliberately not monotone: the provider that mentions the brand
// most often is not the one that describes it best, and the one that cites
// owned pages most is middling at both. A reader has to actually read the row.

export interface ProviderProfile {
  /** Multiplier on the mention rate for this provider's rows. */
  mention: number;
  /** Offset in judge points on the accuracy arc. */
  accuracy: number;
  /** Multiplier on the owned-citation rate. */
  owned: number;
  /** Multiplier on every competitor's share. */
  competitor: number;
}

const PROVIDER_PROFILES: readonly ProviderProfile[] = [
  { mention: 1.08, accuracy: 0.15, owned: 1.25, competitor: 1.0 },
  { mention: 1.03, accuracy: 0.45, owned: 0.8, competitor: 1.06 },
  { mention: 0.97, accuracy: -0.35, owned: 1.1, competitor: 0.94 },
  { mention: 0.9, accuracy: 0.25, owned: 0.55, competitor: 1.12 },
  { mention: 1.06, accuracy: -0.5, owned: 1.3, competitor: 0.9 },
  { mention: 0.86, accuracy: 0.05, owned: 0.95, competitor: 1.0 },
];

export function providerProfile(targetIndex: number): ProviderProfile {
  return PROVIDER_PROFILES[targetIndex % PROVIDER_PROFILES.length];
}
