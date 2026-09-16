import pLimit from "p-limit";
import { getProvider } from "./providers/registry.js";
import { JsonlStore } from "./storage/index.js";
import type { RunConfig } from "./types/config.js";
import { logger } from "./util/logger.js";

export async function runAll(config: RunConfig): Promise<void> {
  const limit = pLimit(config.concurrency);
  const store = new JsonlStore(config.outputDir);

  const tasks: Array<Promise<void>> = [];
  let completed = 0;
  const total = config.prompts.length * config.targets.length;

  logger.info(
    {
      prompts: config.prompts.length,
      targets: config.targets.length,
      total,
      concurrency: config.concurrency,
      outputFile: store.getFilePath(),
    },
    "Starting run",
  );

  for (const prompt of config.prompts) {
    for (const target of config.targets) {
      tasks.push(
        limit(async () => {
          const provider = getProvider(target.provider);

          const result = await provider.run({
            prompt: prompt.prompt,
            promptCategory: prompt.category,
            promptMeta: prompt.meta,
            model: target.model,
            runId: config.runId,
            options: target.options,
          });

          await store.append(result);

          completed++;
          logger.info(
            {
              completed,
              total,
              provider: target.provider,
              model: target.model,
              hasError: result.error !== null,
            },
            `Progress: ${completed}/${total}`,
          );
        }),
      );
    }
  }

  await Promise.all(tasks);

  logger.info(
    { total: completed, outputFile: store.getFilePath() },
    "Run complete",
  );
}
