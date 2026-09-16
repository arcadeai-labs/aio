// Corpus reconciliation. `bun run ingest` (no args) hashes every discovered run
// against its `ingest_runs` record and re-ingests any run that is NEW or whose
// source CHANGED (current or historical); unchanged runs are skipped.
// `--week DATE` forces a single run regardless of hash.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AnalyticsConfig } from "@aio/core";
import { db, ingestRuns } from "@aio/db";
import {
  discoverRuns,
  hashFile,
  parseResults,
  parseVerdicts,
} from "./corpus.js";
import { buildRunBundle } from "./transform.js";
import { writeRunBundle } from "./writer.js";

export async function loadConfig(configPath: string): Promise<AnalyticsConfig> {
  return JSON.parse(await readFile(configPath, "utf8")) as AnalyticsConfig;
}

export interface ReconcileOptions {
  /** Force a single dated run (YYYY-MM-DD), ignoring the hash check. */
  week?: string;
  /** Path to analytics.config.json (default: <cwd>/analytics.config.json). */
  configPath?: string;
  /** Base dir for resolving config's relative results/output dirs (default cwd). */
  cwd?: string;
  /** Sink for progress lines (default console.log). */
  log?: (msg: string) => void;
}

export interface RunReconcileResult {
  runDate: string;
  action: "ingested" | "skipped";
  resultCount?: number;
  verdictCount?: number;
  orphanVerdictCount?: number;
}

export async function reconcileCorpus(
  opts: ReconcileOptions = {},
): Promise<RunReconcileResult[]> {
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.log ?? ((m: string) => console.log(m));
  const configPath = opts.configPath ?? resolve(cwd, "analytics.config.json");

  const config = await loadConfig(configPath);
  const resultsDir = resolve(cwd, config.resultsDir);
  const analysisDir = resolve(cwd, config.outputDir);

  let runs = await discoverRuns(resultsDir, analysisDir);
  if (opts.week) {
    const wanted = runs.filter((r) => r.runDate === opts.week);
    if (wanted.length === 0) {
      throw new Error(
        `No results-${opts.week}.jsonl found under ${resultsDir}`,
      );
    }
    runs = wanted;
  }

  // Existing provenance, keyed by run date, for the hash-skip decision.
  const existing = new Map<
    string,
    { resultsFileHash: string; analysisFileHash: string | null }
  >();
  for (const row of await db.select().from(ingestRuns)) {
    existing.set(row.runDate, {
      resultsFileHash: row.resultsFileHash,
      analysisFileHash: row.analysisFileHash,
    });
  }

  const outcomes: RunReconcileResult[] = [];

  for (const run of runs) {
    const resultsFileHash = await hashFile(run.resultsPath);
    const analysisFileHash = run.analysisPath
      ? await hashFile(run.analysisPath)
      : null;

    const prior = existing.get(run.runDate);
    const unchanged =
      !opts.week &&
      prior != null &&
      prior.resultsFileHash === resultsFileHash &&
      (prior.analysisFileHash ?? null) === analysisFileHash;

    if (unchanged) {
      log(`· ${run.runDate}  skipped (unchanged)`);
      outcomes.push({ runDate: run.runDate, action: "skipped" });
      continue;
    }

    const [results, verdicts] = await Promise.all([
      parseResults(run.resultsPath),
      run.analysisPath ? parseVerdicts(run.analysisPath) : Promise.resolve([]),
    ]);

    const bundle = buildRunBundle({
      runDate: run.runDate,
      results,
      verdicts,
      config,
    });

    const outcome = await writeRunBundle(bundle, {
      resultsFileHash,
      analysisFileHash,
    });

    const orphanNote =
      outcome.orphanVerdictCount > 0
        ? `, ${outcome.orphanVerdictCount} orphan verdict(s) skipped`
        : "";
    log(
      `✓ ${run.runDate}  ${outcome.resultCount} results, ` +
        `${outcome.verdictCount} verdicts${orphanNote}`,
    );
    outcomes.push({
      runDate: run.runDate,
      action: "ingested",
      resultCount: outcome.resultCount,
      verdictCount: outcome.verdictCount,
      orphanVerdictCount: outcome.orphanVerdictCount,
    });
  }

  return outcomes;
}
