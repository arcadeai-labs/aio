// DB writer: persist one RunBundle as a per-run WHOLESALE TRANSACTIONAL REPLACE.
//
// In a single transaction (DASHBOARD_SPEC.md §5):
//   1. upsert the prompts dimension (latest-seen wins; never deleted by a run)
//   2. upsert prompt_labels (union across runs; dormant in v1)
//   3. delete this run's results → CASCADE nukes verdicts + all children
//      (no diffing, no orphans, superseded analysis gone)
//   4. re-insert results + search/citation children
//   5. re-insert verdicts + their children (orphans already dropped upstream)
//   6. replace this run's config snapshot
//   7. upsert the ingest_runs provenance row
//
// Idempotent + supersession-safe: re-running with changed source rebuilds the
// run from scratch.

import {
  citations,
  competitorCitedUrls,
  competitorMentions,
  configAliases,
  configCompetitors,
  configOwnedDomains,
  configSnapshots,
  db,
  ingestRuns,
  promptLabels,
  prompts,
  results,
  searchQueries,
  searchResults,
  verdictExcerpts,
  verdictOwnedUrls,
  verdicts,
} from "@aio/db";
import { eq, sql } from "drizzle-orm";
import type { RunBundle } from "./transform.js";

// Postgres caps a statement at 65535 bind params. Chunk multi-row inserts well
// under that, accounting for the widest row (results ~19 cols).
const CHUNK_ROWS = 1000;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertChunked<T>(
  tx: Tx,
  // biome-ignore lint/suspicious/noExplicitAny: drizzle table types vary per call
  table: any,
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    await tx.insert(table).values(rows.slice(i, i + CHUNK_ROWS));
  }
}

export interface WriteOutcome {
  runDate: string;
  resultCount: number;
  verdictCount: number;
  orphanVerdictCount: number;
}

export async function writeRunBundle(
  bundle: RunBundle,
  hashes: { resultsFileHash: string; analysisFileHash: string | null },
): Promise<WriteOutcome> {
  await db.transaction(async (tx) => {
    // 1. Prompts dimension — latest-seen classification wins, first/last span
    // widened. Re-ingesting an OLD run must not clobber newer classification:
    // theme/branded_type/location/text update only when THIS run is at least as
    // recent as the dimension's last-seen run.
    for (let i = 0; i < bundle.prompts.length; i += CHUNK_ROWS) {
      await tx
        .insert(prompts)
        .values(bundle.prompts.slice(i, i + CHUNK_ROWS))
        .onConflictDoUpdate({
          target: prompts.promptId,
          set: {
            text: sql`case when excluded.last_seen_run >= ${prompts.lastSeenRun} then excluded.text else ${prompts.text} end`,
            theme: sql`case when excluded.last_seen_run >= ${prompts.lastSeenRun} then excluded.theme else ${prompts.theme} end`,
            brandedType: sql`case when excluded.last_seen_run >= ${prompts.lastSeenRun} then excluded.branded_type else ${prompts.brandedType} end`,
            location: sql`case when excluded.last_seen_run >= ${prompts.lastSeenRun} then excluded.location else ${prompts.location} end`,
            firstSeenRun: sql`least(${prompts.firstSeenRun}, excluded.first_seen_run)`,
            lastSeenRun: sql`greatest(${prompts.lastSeenRun}, excluded.last_seen_run)`,
          },
        });
    }

    // 2. Prompt labels — union across runs (dormant in v1).
    for (let i = 0; i < bundle.promptLabels.length; i += CHUNK_ROWS) {
      await tx
        .insert(promptLabels)
        .values(bundle.promptLabels.slice(i, i + CHUNK_ROWS))
        .onConflictDoNothing();
    }

    // 3. Wipe the run (cascades to verdicts + every child table).
    await tx.delete(results).where(eq(results.runDate, bundle.runDate));

    // 4. Results + their search/citation children.
    await insertChunked(tx, results, bundle.results);
    await insertChunked(tx, searchQueries, bundle.searchQueries);
    await insertChunked(tx, searchResults, bundle.searchResults);
    await insertChunked(tx, citations, bundle.citations);

    // 5. Verdicts + children.
    await insertChunked(tx, verdicts, bundle.verdicts);
    await insertChunked(tx, verdictExcerpts, bundle.verdictExcerpts);
    await insertChunked(tx, verdictOwnedUrls, bundle.verdictOwnedUrls);
    await insertChunked(tx, competitorMentions, bundle.competitorMentions);
    await insertChunked(tx, competitorCitedUrls, bundle.competitorCitedUrls);

    // 6. Config snapshot (replace this run's).
    if (bundle.config) {
      await tx
        .delete(configSnapshots)
        .where(eq(configSnapshots.runDate, bundle.runDate));
      const [snap] = await tx
        .insert(configSnapshots)
        .values({
          runDate: bundle.config.runDate,
          brandName: bundle.config.brandName,
          groundTruthDescription: bundle.config.groundTruthDescription,
          judgeProvider: bundle.config.judgeProvider,
          judgeModel: bundle.config.judgeModel,
          raw: bundle.config.raw,
        })
        .returning({ id: configSnapshots.id });
      const snapshotId = snap.id;
      if (bundle.config.ownedDomains.length > 0) {
        await insertChunked(
          tx,
          configOwnedDomains,
          bundle.config.ownedDomains.map((domain) => ({ snapshotId, domain })),
        );
      }
      if (bundle.config.competitors.length > 0) {
        await insertChunked(
          tx,
          configCompetitors,
          bundle.config.competitors.map((name) => ({ snapshotId, name })),
        );
      }
      if (bundle.config.aliases.length > 0) {
        await insertChunked(
          tx,
          configAliases,
          bundle.config.aliases.map((alias) => ({ snapshotId, alias })),
        );
      }
    }

    // 7. Provenance.
    const status =
      bundle.orphanVerdictIds.length > 0 ? "ok_with_orphans" : "ok";
    await tx
      .insert(ingestRuns)
      .values({
        runDate: bundle.runDate,
        resultsFileHash: hashes.resultsFileHash,
        analysisFileHash: hashes.analysisFileHash,
        resultCount: bundle.results.length,
        verdictCount: bundle.verdicts.length,
        orphanVerdictCount: bundle.orphanVerdictIds.length,
        status,
      })
      .onConflictDoUpdate({
        target: ingestRuns.runDate,
        set: {
          resultsFileHash: hashes.resultsFileHash,
          analysisFileHash: hashes.analysisFileHash,
          resultCount: bundle.results.length,
          verdictCount: bundle.verdicts.length,
          orphanVerdictCount: bundle.orphanVerdictIds.length,
          status,
          ingestedAt: sql`now()`,
        },
      });
  });

  return {
    runDate: bundle.runDate,
    resultCount: bundle.results.length,
    verdictCount: bundle.verdicts.length,
    orphanVerdictCount: bundle.orphanVerdictIds.length,
  };
}
