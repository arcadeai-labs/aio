// `bun run learnings` — the learnings pipeline step. Reads ANALYSIS_DATE
// (defaults to today), runs each registered generator failure-isolated, and
// writes one validated record per slug to
// `results/analysis/learnings/<date>/<slug>.json`.
//
// Scope (issue #33): the tracer bullet through Movers. Resume/select semantics
// (`LEARNING=<slug>`, skip-already-ok) and the additional catalog generators
// arrive in follow-up issues; the registry is already the extension point.

import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Learning } from "@aio/core";
import OpenAI from "openai";
import { loadAnalyticsConfig } from "../analytics/config.js";
import { logger } from "../util/logger.js";
import { generatorProvenance } from "./harness.js";
import { type LearningGenerator, REGISTRY } from "./registry.js";
import { assertValidLearning } from "./validate.js";

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Degraded record written when a generator throws — never fails the run. */
function unavailableRecord(
  generator: LearningGenerator,
  runDate: string,
  provenance: string,
  reason: string,
): Learning {
  return {
    slug: generator.slug,
    tier: generator.tier,
    runDate,
    status: "unavailable",
    headline: "Learning unavailable",
    body: `This learning could not be generated for ${runDate}: ${reason}`,
    evidence: [],
    confidence: "low",
    generator: provenance,
    generatedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const date =
    process.env.ANALYSIS_DATE ?? new Date().toISOString().slice(0, 10);

  const config = await loadAnalyticsConfig();
  const outputDir = resolve(config.outputDir);

  // Error fast if the run's analysis inputs are absent, so the operator runs
  // the step in the correct order (after `analyze`) — PRD user story 14. This
  // is a hard fail on purpose: a missing comparison should surface loudly, not
  // degrade to an empty slot. Every generator in the current catalog consumes
  // the comparison; when a comparison-independent generator is added, gate this
  // check on the registered slugs rather than making it unconditional.
  const comparisonPath = join(outputDir, `comparison-${date}.json`);
  if (!(await fileExists(comparisonPath))) {
    throw new Error(
      `No comparison file for ${date} at ${comparisonPath}. Run \`bun run analyze\` for this date first (a learnings run needs the week-over-week comparison).`,
    );
  }

  const learningsDir = join(outputDir, "learnings", date);
  await mkdir(learningsDir, { recursive: true });

  const client = new OpenAI();
  logger.info(
    { date, outputDir, generators: REGISTRY.map((g) => g.slug) },
    "Starting learnings",
  );

  for (const generator of REGISTRY) {
    const ctx = { runDate: date, outputDir, config, client };
    let record: Learning;
    try {
      record = await generator.generate(ctx);
      assertValidLearning(record);
      logger.info(
        { slug: generator.slug, status: record.status },
        "Generated learning",
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error(
        { slug: generator.slug, err: reason },
        "Generator failed — writing unavailable slot",
      );
      record = unavailableRecord(
        generator,
        date,
        generatorProvenance(generator.slug, config),
        reason,
      );
    }

    const outPath = join(learningsDir, `${generator.slug}.json`);
    await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
    logger.info({ outPath }, "Learning written");
  }

  logger.info("Learnings pipeline complete");
}

main().catch((err) => {
  logger.fatal(err, "Fatal error in learnings");
  process.exit(1);
});
