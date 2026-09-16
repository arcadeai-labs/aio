import { resolve } from "node:path";
import { loadPrompts, loadTargets } from "./load.js";
import { reportRunSummary } from "./run-summary.js";
import { runAll } from "./runner.js";
import type { RunConfig } from "./types/config.js";
import { logger } from "./util/logger.js";

async function main(): Promise<void> {
  const promptsFile = resolve(
    process.env.PROMPTS_FILE ?? "prompts/default.csv",
  );
  const outputDir = resolve(process.env.OUTPUT_DIR ?? "results");
  const concurrency = Number.parseInt(process.env.CONCURRENCY ?? "3", 10);

  const prompts = await loadPrompts(promptsFile);
  if (prompts.length === 0) {
    logger.error({ file: promptsFile }, "No prompts found");
    process.exit(1);
  }

  const targets = await loadTargets();

  const config: RunConfig = {
    prompts,
    targets,
    outputDir,
    concurrency,
    runId: crypto.randomUUID(),
  };

  logger.info(
    {
      runId: config.runId,
      promptCount: prompts.length,
      targetCount: targets.length,
      outputDir,
    },
    "Configuration loaded",
  );

  const summary = await runAll(config);
  reportRunSummary(summary);

  // A provider-level failure must not exit clean. Errored rows are excluded
  // from every downstream denominator, so a run that quietly lost a provider
  // still moves the dashboard — for reasons that have nothing to do with the
  // brand. Absent credentials are exempt (the README promises the rest of the
  // run completes), unless nothing succeeded at all.
  if (!summary.ok) process.exit(1);
}

main().catch((err) => {
  logger.fatal(err, "Fatal error");
  process.exit(1);
});
