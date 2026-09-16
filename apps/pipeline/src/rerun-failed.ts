import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pLimit from "p-limit";
import { getProvider } from "./providers/registry.js";
import {
  type TargetOutcome,
  distinctTargets,
  reportRunSummary,
  summarizeRun,
} from "./run-summary.js";
import { targetForProvider } from "./targets.js";
import type { TargetEntry } from "./types/config.js";
import type { UnifiedResult } from "./types/unified-result.js";
import { logger } from "./util/logger.js";

/**
 * Targeted re-run of only the failed records in an existing results file.
 *
 * Reads results-<date>.jsonl, re-runs the (prompt, provider) pairs whose
 * `error` is non-null, and rewrites the file as: good rows + fresh results.
 * Old error rows are replaced (not appended) because the analytics loader
 * does not dedup — leaving them would double-count and drag down metrics.
 *
 * Usage:
 *   bun run src/rerun-failed.ts [date]
 *   RERUN_PROVIDERS=perplexity,exa bun run src/rerun-failed.ts 2026-06-01
 *
 * Env:
 *   RESULTS_DIR        results directory (default "results")
 *   CONCURRENCY        parallel re-runs (default 3)
 *   RERUN_PROVIDERS    comma-separated provider allowlist (default: all)
 */
async function main(): Promise<void> {
  const resultsDir = resolve(process.env.RESULTS_DIR ?? "results");
  const concurrency = Number.parseInt(process.env.CONCURRENCY ?? "3", 10);
  const providerFilter = (process.env.RERUN_PROVIDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const date = process.argv[2] ?? (await latestResultsDate(resultsDir));
  if (!date) {
    logger.error({ resultsDir }, "No results file found to re-run");
    process.exit(1);
  }

  const filePath = join(resultsDir, `results-${date}.jsonl`);
  const content = await readFile(filePath, "utf-8");
  const records: UnifiedResult[] = content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as UnifiedResult);

  const good = records.filter((r) => r.error === null);
  let failed = records.filter((r) => r.error !== null);
  if (providerFilter.length > 0) {
    const keep = new Set(providerFilter);
    const skipped = failed.filter((r) => !keep.has(r.metadata.provider));
    failed = failed.filter((r) => keep.has(r.metadata.provider));
    // Skipped failures stay in the file untouched.
    good.push(...skipped);
  }

  logger.info(
    {
      date,
      total: records.length,
      good: records.length - records.filter((r) => r.error !== null).length,
      toRerun: failed.length,
      providerFilter: providerFilter.length ? providerFilter : "all",
      concurrency,
    },
    "Re-running failed records",
  );

  if (failed.length === 0) {
    logger.info({ date }, "Nothing to re-run; file already clean");
    return;
  }

  const runId = crypto.randomUUID();
  const limit = pLimit(concurrency);
  let done = 0;
  let stillFailing = 0;
  const outcomes: TargetOutcome[] = [];
  const attempted: TargetEntry[] = [];

  const reruns = await Promise.all(
    failed.map((rec) =>
      limit(async () => {
        const target = targetForProvider(rec.metadata.provider);
        if (!target) {
          logger.warn(
            { provider: rec.metadata.provider, id: rec.id },
            "No target config for provider; keeping original error record",
          );
          // Still an unrecovered failure — count it so the summary cannot
          // report a clean re-run over records it never touched.
          outcomes.push({
            provider: rec.metadata.provider,
            model: rec.metadata.model,
            error: rec.error,
          });
          return rec;
        }

        const provider = getProvider(target.provider);
        const result = await provider.run({
          prompt: rec.prompt,
          promptCategory: rec.promptCategory,
          promptMeta: rec.promptMeta,
          model: target.model,
          runId,
          options: target.options,
        });

        attempted.push(target);
        outcomes.push({
          provider: target.provider,
          model: target.model,
          error: result.error,
        });

        done++;
        if (result.error !== null) stillFailing++;
        logger.info(
          {
            done,
            total: failed.length,
            provider: target.provider,
            ok: result.error === null,
          },
          `Re-run ${done}/${failed.length}`,
        );
        return result;
      }),
    ),
  );

  // Rewrite atomically: back up the original, then write good + reruns.
  const rebuilt = [...good, ...reruns];
  const tmpPath = `${filePath}.tmp`;
  await writeFile(
    tmpPath,
    `${rebuilt.map((r) => JSON.stringify(r)).join("\n")}\n`,
    "utf-8",
  );
  await rename(filePath, `${filePath}.bak`);
  await rename(tmpPath, filePath);

  logger.info(
    {
      date,
      rerun: failed.length,
      recovered: failed.length - stillFailing,
      stillFailing,
      finalRecords: rebuilt.length,
      backup: `${filePath}.bak`,
    },
    "Re-run complete",
  );

  // Only the targets this re-run actually retried; a target with nothing left
  // to recover was never attempted here.
  const summary = summarizeRun(distinctTargets(attempted), outcomes);
  reportRunSummary(summary);
  if (!summary.ok) process.exit(1);
}

async function latestResultsDate(resultsDir: string): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(resultsDir);
  } catch {
    return null;
  }
  const dates = files
    .filter((f) => f.startsWith("results-") && f.endsWith(".jsonl"))
    .map((f) => f.replace("results-", "").replace(".jsonl", ""))
    .sort();
  return dates.at(-1) ?? null;
}

main().catch((err) => {
  logger.fatal(err, "Fatal error during re-run");
  process.exit(1);
});
