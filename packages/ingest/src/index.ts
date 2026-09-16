// @aio/ingest — JSONL + config → Postgres reconciler (run from the laptop).
//
// Hash-based corpus reconciliation with per-run wholesale transactional replace
// (issue #4). Reads canonical results-*.jsonl / analysis-*.jsonl from the dirs
// named in analytics.config.json (cwd-relative, matching the pipeline) and the
// effective config, then writes the normalized @aio/db schema.
//
//   bun run ingest                 reconcile the whole corpus (skip unchanged)
//   bun run ingest --week 2026-05-11   force a single dated run

import { reconcileCorpus } from "./reconcile.js";

export * from "./normalize.js";
export * from "./transform.js";
export * from "./corpus.js";
export { writeRunBundle, type WriteOutcome } from "./writer.js";
export {
  loadConfig,
  reconcileCorpus,
  type ReconcileOptions,
  type RunReconcileResult,
} from "./reconcile.js";

function parseArgs(argv: string[]): { week?: string } {
  let week: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--week") {
      week = argv[++i];
    } else if (arg.startsWith("--week=")) {
      week = arg.slice("--week=".length);
    }
  }
  if (week && !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
    throw new Error(`--week expects a YYYY-MM-DD date, got "${week}"`);
  }
  return { week };
}

async function main(): Promise<void> {
  const { week } = parseArgs(process.argv.slice(2));
  const t0 = performance.now();
  const outcomes = await reconcileCorpus({ week });

  const ingested = outcomes.filter((o) => o.action === "ingested");
  const skipped = outcomes.filter((o) => o.action === "skipped");
  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(
    `\n${ingested.length} ingested, ${skipped.length} skipped in ${elapsed}s`,
  );
}

// Only run the CLI when executed directly (not when imported by tests).
if (import.meta.main) {
  await main();
  process.exit(0);
}
