// End-to-end reconciler tests against a real Postgres. Skipped automatically
// when no DB is reachable (DATABASE_URL unset / server down), so the pure suite
// still runs anywhere. Locally: a throwaway Docker Postgres 16 on :5432.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  competitorMentions,
  configSnapshots,
  db,
  ingestRuns,
  prompts,
  results,
  verdicts,
} from "@aio/db";
import { eq, sql } from "drizzle-orm";
import { promptId } from "../src/normalize.js";
import { reconcileCorpus } from "../src/reconcile.js";
import { makeResult, makeVerdict } from "./fixtures.js";

const RUN = "2099-01-01";
const P1 = "FIXTURE: how does the action runtime work?";
const P2 = "FIXTURE: best agent auth platforms?";
const PID1 = promptId(P1);
const PID2 = promptId(P2);

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
  console.warn("[reconcile.test] no DB reachable — skipping DB-backed suite");
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await writeFile(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

const CONFIG = {
  brand: {
    name: "Taskwell",
    aliases: ["Taskwell.app"],
    ownedDomains: ["taskwell.app"],
    groundTruthDescription: "the action runtime",
    knownCompetitors: ["Todoist", "Notion"],
  },
  judgeModel: { provider: "openai", model: "gpt-5.2" },
  concurrency: 5,
  resultsDir: "results",
  outputDir: "results/analysis",
};

suite("reconcileCorpus (DB-backed)", () => {
  let dir: string;
  let resultsPath: string;
  let analysisPath: string;

  async function cleanup(): Promise<void> {
    await db.delete(results).where(eq(results.runDate, RUN));
    await db.delete(configSnapshots).where(eq(configSnapshots.runDate, RUN));
    await db.delete(ingestRuns).where(eq(ingestRuns.runDate, RUN));
    await db.delete(prompts).where(eq(prompts.promptId, PID1));
    await db.delete(prompts).where(eq(prompts.promptId, PID2));
  }

  beforeAll(async () => {
    await cleanup();
    dir = await mkdtemp(join(tmpdir(), "aio-ingest-"));
    await writeFile(join(dir, "analytics.config.json"), JSON.stringify(CONFIG));
    const resultsDir = join(dir, "results");
    const analysisDir = join(resultsDir, "analysis");
    await Bun.write(join(analysisDir, ".keep"), ""); // mkdir -p both dirs
    resultsPath = join(resultsDir, `results-${RUN}.jsonl`);
    analysisPath = join(analysisDir, `analysis-${RUN}.jsonl`);

    await writeJsonl(resultsPath, [
      makeResult({ id: "fr1", prompt: P1 }),
      makeResult({ id: "fr2", prompt: P2 }),
    ]);
    // .bak must be ignored by discovery — give it bogus content.
    await writeFile(`${resultsPath}.bak`, "GARBAGE NOT JSON\n");
    await writeJsonl(analysisPath, [
      makeVerdict({ resultId: "fr1", prompt: P1 }),
      makeVerdict({
        resultId: "fr2",
        prompt: P2,
        competitivePosition: {
          othersPresent: true,
          othersCount: 1,
          brandRank: "not_ranked",
          competitors: [
            { name: "Todoist", mentioned: true, citedUrls: [] },
            { name: "Notion", mentioned: false, citedUrls: [] },
          ],
        },
      }),
    ]);
  });

  afterAll(async () => {
    await cleanup();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("first reconcile ingests the run; .bak is ignored", async () => {
    const outcomes = await reconcileCorpus({ cwd: dir, log: () => {} });
    const mine = outcomes.filter((o) => o.runDate === RUN);
    // Exactly one run discovered for the date (the .bak did not become a 2nd).
    expect(mine).toHaveLength(1);
    expect(mine[0].action).toBe("ingested");

    const rRows = await db
      .select()
      .from(results)
      .where(eq(results.runDate, RUN));
    expect(rRows).toHaveLength(2);
    const vCount = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(verdicts)
      .where(eq(verdicts.resultId, "fr2"));
    expect(vCount[0].n).toBe(1);

    // Only mentioned=true competitors stored.
    const comps = await db
      .select()
      .from(competitorMentions)
      .where(eq(competitorMentions.resultId, "fr2"));
    expect(comps.map((c) => c.competitorName)).toEqual(["Todoist"]);

    // Config snapshot captured.
    const snap = await db
      .select()
      .from(configSnapshots)
      .where(eq(configSnapshots.runDate, RUN));
    expect(snap).toHaveLength(1);
    expect(snap[0].brandName).toBe("Taskwell");
  });

  test("unchanged source is skipped on the next reconcile (hash-skip)", async () => {
    const outcomes = await reconcileCorpus({ cwd: dir, log: () => {} });
    const mine = outcomes.find((o) => o.runDate === RUN);
    expect(mine?.action).toBe("skipped");
  });

  test("changed source wholesale-replaces: no dupes, superseded rows gone", async () => {
    // Re-judge fr2: drop the Todoist mention, mark Taskwell mentioned. The old
    // verdict + competitor row must vanish (not accumulate).
    await writeJsonl(analysisPath, [
      makeVerdict({ resultId: "fr1", prompt: P1 }),
      makeVerdict({
        resultId: "fr2",
        prompt: P2,
        analyzedAt: "2099-02-01T00:00:00.000Z",
        brandMention: {
          mentioned: true,
          mentionCount: 2,
          excerpts: ["Taskwell ..."],
        },
        competitivePosition: {
          othersPresent: false,
          othersCount: 0,
          brandRank: 1,
          competitors: [{ name: "Todoist", mentioned: false, citedUrls: [] }],
        },
      }),
    ]);

    const outcomes = await reconcileCorpus({ cwd: dir, log: () => {} });
    expect(outcomes.find((o) => o.runDate === RUN)?.action).toBe("ingested");

    // Still exactly one verdict per result (wholesale replace, no duplicates).
    const v = await db
      .select()
      .from(verdicts)
      .where(eq(verdicts.resultId, "fr2"));
    expect(v).toHaveLength(1);
    expect(v[0].mentioned).toBe(true);
    expect(v[0].brandRank).toBe("1");

    // Superseded competitor mention is gone.
    const comps = await db
      .select()
      .from(competitorMentions)
      .where(eq(competitorMentions.resultId, "fr2"));
    expect(comps).toHaveLength(0);

    // No orphans recorded for a clean run.
    const prov = await db
      .select()
      .from(ingestRuns)
      .where(eq(ingestRuns.runDate, RUN));
    expect(prov[0].orphanVerdictCount).toBe(0);
    expect(prov[0].verdictCount).toBe(2);
  });

  test("orphan verdicts are skipped and flagged in provenance", async () => {
    await writeJsonl(analysisPath, [
      makeVerdict({ resultId: "fr1", prompt: P1 }),
      makeVerdict({ resultId: "fr2", prompt: P2 }),
      makeVerdict({ resultId: "ghost-result", prompt: P1 }), // no matching result
    ]);

    await reconcileCorpus({ cwd: dir, log: () => {} });

    const ghost = await db
      .select()
      .from(verdicts)
      .where(eq(verdicts.resultId, "ghost-result"));
    expect(ghost).toHaveLength(0);

    const prov = await db
      .select()
      .from(ingestRuns)
      .where(eq(ingestRuns.runDate, RUN));
    expect(prov[0].orphanVerdictCount).toBe(1);
    expect(prov[0].status).toBe("ok_with_orphans");
  });
});
