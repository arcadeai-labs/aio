// Corpus to disk. Deliberately dumb: it decides nothing about content and
// writes results through `JsonlStore` — the same writer `runner.ts` uses — so
// seeded output cannot drift from real output. A second writer here would let
// the dashboard be exercised against a file shape the pipeline never produces.
//
// Verdicts go out the way `analytics/analyzer.ts` writes them: one JSON object
// per line into `analysis-YYYY-MM-DD.jsonl` under the config's `outputDir`.
//
// The week-over-week `comparison-YYYY-MM-DD.json` is written the same way and
// for the same reason: through `compareWeeks`, the function `bun run analyze`
// itself calls (analytics/index.ts). Deriving the deltas here would be a second
// implementation of the one contract SCHEMA.md documents with no table behind
// it — and a fixture that agreed with the document while disagreeing with the
// comparator would verify nothing. This is what puts `WeekComparison`,
// `ResultDelta` and `WeekComparisonSummary` inside the credential-free
// corpus's reach (#34).

import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareWeeks } from "../analytics/comparator.js";
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
  /** `comparison-DATE.json`, or null for the oldest run — it has no previous week. */
  comparisonPath: string | null;
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
  for (const [index, run] of corpus.runs.entries()) {
    emitted.push(await emitRun(run, corpus.runs[index - 1] ?? null, options));
  }
  return emitted;
}

async function emitRun(
  run: SeededRun,
  previous: SeededRun | null,
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

  // Both writers append, and a re-seed has to reproduce the same bytes rather
  // than stack a second corpus behind the first. The comparison is removed too:
  // a shorter `SEED_WEEKS` would otherwise leave the previous run's comparison
  // sitting beside what is now the oldest week, which has none.
  await rm(resultsPath, { force: true });
  await rm(analysisPath, { force: true });
  await rm(join(options.analysisDir, `comparison-${run.runDate}.json`), {
    force: true,
  });

  for (const result of run.results) {
    await store.append(result);
  }

  await mkdir(dirname(analysisPath), { recursive: true });
  for (const verdict of run.verdicts) {
    await appendFile(analysisPath, `${JSON.stringify(verdict)}\n`, "utf-8");
  }

  // The oldest run has nothing to compare against, exactly as `bun run analyze`
  // finds nothing on the first week it ever judges.
  let comparisonPath: string | null = null;
  if (previous) {
    comparisonPath = join(
      options.analysisDir,
      `comparison-${run.runDate}.json`,
    );
    const comparison = compareWeeks(
      run.verdicts,
      previous.verdicts,
      run.runDate,
      previous.runDate,
    );
    await writeFile(
      comparisonPath,
      JSON.stringify(comparison, null, 2),
      "utf-8",
    );
  }

  return {
    runDate: run.runDate,
    resultsPath,
    analysisPath,
    comparisonPath,
    resultCount: run.results.length,
    verdictCount: run.verdicts.length,
  };
}
