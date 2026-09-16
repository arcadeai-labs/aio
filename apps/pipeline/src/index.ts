import { resolve } from "node:path";
import { loadPrompts, loadTargets } from "./load.js";
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

  await runAll(config);
}

main().catch((err) => {
  logger.fatal(err, "Fatal error");
  process.exit(1);
});
