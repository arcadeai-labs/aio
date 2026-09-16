// Corpus to disk. Deliberately dumb: it decides nothing about content and
// writes results through `JsonlStore` — the same writer `runner.ts` uses — so
// seeded output cannot drift from real output. A second writer here would let
// the dashboard be exercised against a file shape the pipeline never produces.
//
// Verdicts go out the way `analytics/analyzer.ts` writes them: one JSON object
// per line into `analysis-YYYY-MM-DD.jsonl` under the config's `outputDir`.

import { appendFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { JsonlStore } from "../storage/index.js";
import type { SeededCorpus, SeededRun } from "./scenario.js";

export interface EmitOptions {
  /** Where `results-DATE.jsonl` lands (the config's `resultsDir`). */
  resultsDir: string;
  /** Where `analysis-DATE.jsonl` lands (the config's `outputDir`). */
  analysisDir: string;
}

export interface EmittedRun {
  runDate: string;
  resultsPath: string;
  analysisPath: string;
  resultCount: number;
  verdictCount: number;
}

/**
 * Write every run in the corpus. Both writers append, so each target file is
 * removed first — re-running `bun run seed` has to reproduce the same bytes,
 * not stack a second copy of the corpus behind the first.
 */
export async function emitCorpus(
  corpus: SeededCorpus,
  options: EmitOptions,
): Promise<EmittedRun[]> {
  const emitted: EmittedRun[] = [];
  for (const run of corpus.runs) {
    emitted.push(await emitRun(run, options));
  }
  return emitted;
}

async function emitRun(
  run: SeededRun,
  options: EmitOptions,
): Promise<EmittedRun> {
  const store = new JsonlStore(
    options.resultsDir,
    new Date(`${run.runDate}T00:00:00.000Z`),
  );
  const resultsPath = store.getFilePath();
  const analysisPath = join(
    options.analysisDir,
    `analysis-${run.runDate}.jsonl`,
  );

  await rm(resultsPath, { force: true });
  await rm(analysisPath, { force: true });

  for (const result of run.results) {
    await store.append(result);
  }

  await mkdir(dirname(analysisPath), { recursive: true });
  for (const verdict of run.verdicts) {
    await appendFile(analysisPath, `${JSON.stringify(verdict)}\n`, "utf-8");
  }

  return {
    runDate: run.runDate,
    resultsPath,
    analysisPath,
    resultCount: run.results.length,
    verdictCount: run.verdicts.length,
  };
}
