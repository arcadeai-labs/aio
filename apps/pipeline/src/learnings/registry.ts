// The learnings registry: the single extension point for the catalog. Adding a
// learning means registering a generator module here — no orchestrator surgery.
// A generator is `{ slug, tier, generate() }`; the orchestrator iterates the
// registry in catalog order.

import type { AnalyticsConfig, Learning, LearningTier } from "@aio/core";
import type OpenAI from "openai";
import { MOVERS_SLUG, generateMovers } from "./generators/movers.js";

/** Per-run inputs handed to a generator. */
export interface GeneratorRunContext {
  /** Run date, `YYYY-MM-DD`. */
  runDate: string;
  /** Directory holding the run's analysis/comparison files. */
  outputDir: string;
  config: AnalyticsConfig;
  /** Judge-model client, shared across generators. */
  client: OpenAI;
}

export interface LearningGenerator {
  slug: string;
  tier: LearningTier;
  generate(ctx: GeneratorRunContext): Promise<Learning>;
}

/** Catalog order is the order learnings appear in the dashboard. */
export const REGISTRY: readonly LearningGenerator[] = [
  { slug: MOVERS_SLUG, tier: "structured", generate: generateMovers },
];

export function getGenerator(slug: string): LearningGenerator | undefined {
  return REGISTRY.find((g) => g.slug === slug);
}
