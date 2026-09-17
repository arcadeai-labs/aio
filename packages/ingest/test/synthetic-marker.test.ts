// The query-level end of issue #4, against a real Postgres: a config carrying
// `"synthetic": true` ingests, and `syntheticRunDates()` reads that run back as
// flagged — with no migration and no column, because the flag rides the
// `config_snapshots.raw` snapshot ingest already writes.
//
// The unflagged run is asserted in the same suite, on purpose. A query that
// returns every run would pass the flagged case on its own, and the failure it
// would ship — real measurements labelled invented — is the one this feature
// cannot afford.
//
// Skipped automatically when no DB is reachable, like reconcile.test.ts. Run
// `docker compose --env-file .env.local up -d db` and export DATABASE_URL first:
// `bun test` does not load .env.local, so a green run here can mean nothing ran.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configSnapshots,
  db,
  ingestRuns,
  prompts,
  results,
  syntheticRunDates,
} from "@aio/db";
import { eq, sql } from "drizzle-orm";
import { promptId } from "../src/normalize.js";
import { reconcileCorpus } from "../src/reconcile.js";
import { makeResult, makeVerdict } from "./fixtures.js";

/** Far-future dates so the suite can never collide with a real ingested corpus. */
const SEEDED_RUN = "2098-01-01";
const REAL_RUN = "2098-01-02";
const P = "FIXTURE: which to-do app handles recurring tasks best?";
const PID = promptId(P);

async function canConnect(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

const dbAvailable = await canConnect();
const suite = dbAvailable ? describe : describe.skip;
if (!dbAvailable) {
  console.warn(
    "[synthetic-marker.test] no DB reachable — skipping DB-backed suite",
  );
}

const BASE_CONFIG = {
  brand: {
    name: "Taskwell",
    aliases: ["Taskwell.app"],
    ownedDomains: ["taskwell.app"],
    groundTruthDescription: "a to-do app",
    knownCompetitors: ["Todoist", "TickTick"],
  },
  judgeModel: { provider: "openai", model: "gpt-5.2" },
  concurrency: 5,
  resultsDir: "results",
  outputDir: "results/analysis",
};

/** Ingest one dated run from a throwaway corpus built around `config`. */
async function ingestRun(
  runDate: string,
  config: Record<string, unknown>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aio-synthetic-"));
  await writeFile(join(dir, "analytics.config.json"), JSON.stringify(config));
  const resultsDir = join(dir, "results");
  const analysisDir = join(resultsDir, "analysis");
  await Bun.write(join(analysisDir, ".keep"), "");
  const id = `syn-${runDate}`;
  await writeFile(
    join(resultsDir, `results-${runDate}.jsonl`),
    `${JSON.stringify(makeResult({ id, prompt: P }))}\n`,
  );
  await writeFile(
    join(analysisDir, `analysis-${runDate}.jsonl`),
    `${JSON.stringify(makeVerdict({ resultId: id, prompt: P }))}\n`,
  );
  // `week` forces the run regardless of the hash-skip: a re-ingest below reuses
  // the same fixture bytes and only the config differs, which the hash — taken
  // over the source files, not the config — cannot see.
  await reconcileCorpus({ cwd: dir, week: runDate, log: () => {} });
  return dir;
}

suite("syntheticRunDates (DB-backed)", () => {
  const dirs: string[] = [];

  async function cleanup(): Promise<void> {
    for (const runDate of [SEEDED_RUN, REAL_RUN]) {
      await db.delete(results).where(eq(results.runDate, runDate));
      await db
        .delete(configSnapshots)
        .where(eq(configSnapshots.runDate, runDate));
      await db.delete(ingestRuns).where(eq(ingestRuns.runDate, runDate));
    }
    await db.delete(prompts).where(eq(prompts.promptId, PID));
  }

  beforeAll(async () => {
    await cleanup();
    dirs.push(await ingestRun(SEEDED_RUN, { ...BASE_CONFIG, synthetic: true }));
    // Byte-for-byte the same config minus the flag — the only difference between
    // the two runs is the one field under test.
    dirs.push(await ingestRun(REAL_RUN, BASE_CONFIG));
  });

  afterAll(async () => {
    await cleanup();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  test("the flag reaches config_snapshots.raw as a real boolean", async () => {
    const [snap] = await db
      .select()
      .from(configSnapshots)
      .where(eq(configSnapshots.runDate, SEEDED_RUN));
    expect((snap?.raw as { synthetic?: unknown })?.synthetic).toBe(true);
  });

  test("a flagged run reads back as flagged", async () => {
    expect(await syntheticRunDates()).toContain(SEEDED_RUN);
  });

  test("a run whose config omits the field reads back as not flagged", async () => {
    const [snap] = await db
      .select()
      .from(configSnapshots)
      .where(eq(configSnapshots.runDate, REAL_RUN));
    // Absent, not false: the ingest did not invent a value either way.
    expect(snap).toBeDefined();
    expect((snap?.raw as { synthetic?: unknown })?.synthetic).toBeUndefined();
    expect(await syntheticRunDates()).not.toContain(REAL_RUN);
  });

  test("re-ingesting the flagged run under an unflagged config clears it", async () => {
    // The snapshot is replaced per run, so provenance is not sticky — a run
    // re-ingested from a corrected config stops claiming to be synthetic.
    const dir = await ingestRun(SEEDED_RUN, BASE_CONFIG);
    dirs.push(dir);
    expect(await syntheticRunDates()).not.toContain(SEEDED_RUN);

    // Put it back, so the suite leaves the flagged case asserted both ways.
    dirs.push(await ingestRun(SEEDED_RUN, { ...BASE_CONFIG, synthetic: true }));
    expect(await syntheticRunDates()).toContain(SEEDED_RUN);
  });
});
