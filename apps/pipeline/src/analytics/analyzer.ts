import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import OpenAI from "openai";
import pLimit from "p-limit";
import type { UnifiedResult } from "../types/unified-result.js";
import { logger } from "../util/logger.js";
import { judgeResult } from "./judge.js";
import type { AnalyticsConfig, ResultVerdict } from "./types.js";

export interface AnalyzeOptions {
  /**
   * Reuse the verdicts a previous (possibly crashed) run already wrote to
   * analysis-DATE.jsonl and judge only what's missing.
   */
  resume?: boolean;
  /**
   * Only meaningful with `resume`: verdicts judged before this ISO timestamp
   * are treated as absent and re-judged. Use it to discard an older run's
   * leftovers while keeping the current run's work.
   */
  rejudgeBefore?: string;
}

/**
 * Collapses the verdicts on disk to one per resultId, keeping the most recently
 * judged copy. A crashed run leaves its partial output appended after whatever
 * was already there, so the same resultId can appear more than once.
 */
export function dedupeVerdicts(
  verdicts: ResultVerdict[],
  rejudgeBefore?: string,
): Map<string, ResultVerdict> {
  const byId = new Map<string, ResultVerdict>();

  for (const verdict of verdicts) {
    if (rejudgeBefore && verdict.analyzedAt < rejudgeBefore) continue;

    const existing = byId.get(verdict.resultId);
    if (!existing || verdict.analyzedAt >= existing.analyzedAt) {
      byId.set(verdict.resultId, verdict);
    }
  }

  return byId;
}

async function readVerdictFile(path: string): Promise<ResultVerdict[]> {
  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch {
    return [];
  }

  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ResultVerdict);
}

/**
 * Rewrites the verdict file from `keep`, preserving the pre-rewrite file as
 * `.pre-resume.bak`. Written to a temp file and renamed so a crash mid-rewrite
 * can't leave a truncated verdict file behind.
 */
async function rewriteVerdictFile(
  path: string,
  keep: ResultVerdict[],
): Promise<void> {
  const tmpPath = `${path}.tmp`;
  const body = keep.map((v) => JSON.stringify(v)).join("\n");
  await writeFile(tmpPath, body.length > 0 ? `${body}\n` : "", "utf-8");
  await rename(path, `${path}.pre-resume.bak`);
  await rename(tmpPath, path);
}

export async function analyzeResults(
  results: UnifiedResult[],
  config: AnalyticsConfig,
  date: string,
  options: AnalyzeOptions = {},
): Promise<ResultVerdict[]> {
  const client = new OpenAI();
  const limit = pLimit(config.concurrency);

  const outputPath = join(config.outputDir, `analysis-${date}.jsonl`);
  await mkdir(dirname(outputPath), { recursive: true });

  const valid = results.filter((r) => r.error === null);
  logger.info(
    {
      total: results.length,
      valid: valid.length,
      skipped: results.length - valid.length,
    },
    "Starting analysis",
  );

  const existing = new Map<string, ResultVerdict>();

  if (options.resume) {
    const onDisk = await readVerdictFile(outputPath);
    const validIds = new Set(valid.map((r) => r.id));

    for (const [id, verdict] of dedupeVerdicts(onDisk, options.rejudgeBefore)) {
      if (validIds.has(id)) existing.set(id, verdict);
    }

    if (onDisk.length > 0) {
      // Normalize the file to exactly the verdicts we're keeping, so this run
      // appends onto a clean, duplicate-free base.
      await rewriteVerdictFile(outputPath, [...existing.values()]);
      logger.info(
        {
          linesOnDisk: onDisk.length,
          reused: existing.size,
          dropped: onDisk.length - existing.size,
          rejudgeBefore: options.rejudgeBefore ?? null,
          backup: `${outputPath}.pre-resume.bak`,
        },
        "Resuming from existing verdicts",
      );
    }
  } else {
    // A fresh run must never interleave with a previous run's output.
    const onDisk = await readVerdictFile(outputPath);
    if (onDisk.length > 0) {
      await rename(outputPath, `${outputPath}.bak`);
      logger.warn(
        { lines: onDisk.length, backup: `${outputPath}.bak` },
        "Existing analysis file rotated to .bak (pass --resume to keep it)",
      );
    }
  }

  const pending = valid.filter((r) => !existing.has(r.id));
  if (existing.size > 0) {
    logger.info(
      { reused: existing.size, toJudge: pending.length },
      "Judging only the results without a verdict",
    );
  }

  let completed = 0;
  const verdicts: ResultVerdict[] = [...existing.values()];

  const tasks = pending.map((result) =>
    limit(async () => {
      const verdict = await judgeResult(result, config, client);
      await appendFile(outputPath, `${JSON.stringify(verdict)}\n`, "utf-8");
      verdicts.push(verdict);

      completed++;
      if (completed % 10 === 0 || completed === pending.length) {
        logger.info(
          { completed, total: pending.length, reused: existing.size },
          "Analysis progress",
        );
      }

      return verdict;
    }),
  );

  await Promise.all(tasks);

  logger.info(
    {
      verdicts: verdicts.length,
      outputPath,
      totalJudgeTokens: verdicts.reduce(
        (sum, v) => sum + v.judgeTokens.input + v.judgeTokens.output,
        0,
      ),
    },
    "Analysis complete",
  );

  return verdicts;
}
