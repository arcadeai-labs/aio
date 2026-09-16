// `bun run seed` — the tracer bullet: a fixed seed in, a corpus on disk that
// `bun run ingest` loads and the dashboard renders, with no network calls and
// no API keys.
//
// This file owns every impure step (reading the prompt CSV, reading the
// analytics config, writing files) so `scenario.ts` can own none of them.
//
//   bun run seed                       two weeks, the default seed
//   SEED=another bun run seed          a different corpus
//   SEED_WEEKS=6 bun run seed          more history
//   SEED_ANCHOR_DATE=2026-08-31 bun run seed
//
// The corpus is synthetic and is not marked as such — a dashboard fed by it is
// indistinguishable from one fed by a real run. Marking synthetic data end to
// end is #4's slice; a second, competing scheme invented here would be worse
// than none.

import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { AnalyticsConfig } from "@aio/core";
import { loadAnalyticsConfig } from "../analytics/config.js";
import { loadPrompts, loadTargets } from "../load.js";
import { logger } from "../util/logger.js";
import { emitCorpus } from "./emit.js";
import { createRng } from "./rng.js";
import { type WorldSpec, buildCorpus } from "./scenario.js";

const DEFAULT_SEED = "aio-tracer";
const DEFAULT_WEEKS = 2;
/**
 * A fixed date, not "today": a corpus whose dates depend on when it ran is not
 * reproducible. Runs land on this date and multiples of 7 days before it.
 */
const DEFAULT_ANCHOR_DATE = "2026-09-14";

/**
 * The analytics config, resolved the way `bun run analyze` resolves it
 * (`ANALYTICS_CONFIG`, else `analytics.config.json`) — falling back to the
 * shipped `analytics.config.example.json` when a fresh clone has not copied one
 * into place yet. The example template is the one that pairs with
 * `prompts/default.csv`, so the seeded brand and the seeded prompts agree.
 */
async function resolveConfig(): Promise<{
  config: AnalyticsConfig;
  source: string;
}> {
  const explicit = process.env.ANALYTICS_CONFIG;
  const preferred = resolve(explicit ?? "analytics.config.json");

  try {
    await access(preferred);
    return { config: await loadAnalyticsConfig(preferred), source: preferred };
  } catch {
    if (explicit) {
      throw new Error(
        `ANALYTICS_CONFIG points at a missing file: ${preferred}`,
      );
    }
  }

  const fallback = resolve("analytics.config.example.json");
  logger.warn(
    { fallback },
    "No analytics.config.json — seeding from the shipped example template. " +
      "`bun run ingest` needs analytics.config.json too: " +
      "cp analytics.config.example.json analytics.config.json",
  );
  return { config: await loadAnalyticsConfig(fallback), source: fallback };
}

function readWeeks(): number {
  const raw = process.env.SEED_WEEKS;
  if (!raw) return DEFAULT_WEEKS;
  const weeks = Number.parseInt(raw, 10);
  if (!Number.isFinite(weeks) || weeks < 1) {
    throw new Error(`SEED_WEEKS must be a positive integer, got "${raw}"`);
  }
  return weeks;
}

function readAnchorDate(): string {
  const raw = process.env.SEED_ANCHOR_DATE ?? DEFAULT_ANCHOR_DATE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`SEED_ANCHOR_DATE must be YYYY-MM-DD, got "${raw}"`);
  }
  return raw;
}

async function main(): Promise<void> {
  const seed = process.env.SEED ?? DEFAULT_SEED;
  const promptsFile = resolve(
    process.env.PROMPTS_FILE ?? "prompts/default.csv",
  );

  const { config, source: configPath } = await resolveConfig();
  const prompts = await loadPrompts(promptsFile);
  if (prompts.length === 0) {
    logger.error({ file: promptsFile }, "No prompts found");
    process.exit(1);
  }
  const targets = await loadTargets();

  const spec: WorldSpec = {
    brand: config.brand,
    prompts,
    targets,
    anchorDate: readAnchorDate(),
    weeks: readWeeks(),
    judgeModel: config.judgeModel,
  };

  logger.info(
    {
      seed,
      brand: spec.brand.name,
      configPath,
      promptsFile,
      prompts: prompts.length,
      targets: targets.length,
      weeks: spec.weeks,
      anchorDate: spec.anchorDate,
    },
    "Building seeded corpus",
  );

  const corpus = buildCorpus(spec, createRng(seed));

  const emitted = await emitCorpus(corpus, {
    resultsDir: resolve(config.resultsDir),
    analysisDir: resolve(config.outputDir),
  });

  for (const run of emitted) {
    logger.info(
      {
        runDate: run.runDate,
        results: run.resultCount,
        verdicts: run.verdictCount,
        resultsPath: run.resultsPath,
        analysisPath: run.analysisPath,
      },
      "Run written",
    );
  }

  // A corpus in which the brand matched nothing is this project's signature
  // failure wearing a green tick: every rate reads 0% and the dashboard looks
  // fine. Say so here rather than let it reach Postgres quietly.
  const mentions = corpus.runs.flatMap((r) =>
    r.verdicts.filter((v) => v.brandMention.mentioned),
  );
  if (mentions.length === 0) {
    logger.error(
      { brand: spec.brand.name },
      "Seeded corpus contains zero brand mentions — refusing to call this a success",
    );
    process.exit(1);
  }

  logger.info(
    {
      runs: emitted.length,
      results: emitted.reduce((n, r) => n + r.resultCount, 0),
      verdicts: emitted.reduce((n, r) => n + r.verdictCount, 0),
      mentioned: mentions.length,
      sampleExcerpt: mentions[0].brandMention.excerpts[0],
      next: "bun run ingest",
    },
    "Seed complete",
  );
}

main().catch((err) => {
  logger.fatal(err, "Fatal error in seed");
  process.exit(1);
});
