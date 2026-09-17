import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrandConfig, ResultVerdict, UnifiedResult } from "@aio/core";
import { compareWeeks } from "../src/analytics/comparator.js";
import { emitCorpus } from "../src/seed/emit.js";
import { createRng } from "../src/seed/rng.js";
import { type WorldSpec, buildCorpus } from "../src/seed/scenario.js";
import type { PromptEntry, TargetEntry } from "../src/types/config.js";

// Everything here writes into a fresh temp dir. `results/` and
// `results/analysis/` are gitignored, so a test that read them would pass on
// the author's laptop and fail on a clean clone.
let dir: string;
let resultsDir: string;
let analysisDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aio-seed-emit-"));
  resultsDir = join(dir, "results");
  analysisDir = join(dir, "results", "analysis");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const BRAND: BrandConfig = {
  name: "Taskwell",
  aliases: [],
  ownedDomains: ["taskwell.app"],
  groundTruthDescription: "Taskwell is a cross-platform to-do app.",
  knownCompetitors: ["Todoist", "TickTick"],
};

const PROMPTS: PromptEntry[] = [
  {
    prompt: "What is Taskwell and who is it for?",
    category: "Brand Understanding",
    meta: { brandedType: "Branded" },
  },
  {
    prompt: "What is the best to-do list app in 2026?",
    category: "Discovery & Recommendation",
    meta: { brandedType: "Unbranded" },
  },
];

const TARGETS: TargetEntry[] = [
  { provider: "openai", model: "gpt-5.6-terra" },
  { provider: "anthropic", model: "claude-sonnet-5" },
];

const SPEC: WorldSpec = {
  brand: BRAND,
  prompts: PROMPTS,
  targets: TARGETS,
  anchorDate: "2026-09-14",
  weeks: 2,
  judgeModel: { provider: "openai", model: "gpt-5.2" },
};

function corpus(seed = "emit-test") {
  return buildCorpus(SPEC, createRng(seed));
}

function emit(seed = "emit-test") {
  return emitCorpus(corpus(seed), { resultsDir, analysisDir });
}

async function parseJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf-8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

describe("emitCorpus", () => {
  test("writes one results file and one analysis file per run, named by date", async () => {
    await emit();

    const results = (await readdir(resultsDir))
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
    expect(results).toEqual([
      "results-2026-09-07.jsonl",
      "results-2026-09-14.jsonl",
    ]);
    // One comparison, not two: the oldest run has no previous week to compare
    // against, exactly as `bun run analyze` finds none on the first week.
    expect((await readdir(analysisDir)).sort()).toEqual([
      "analysis-2026-09-07.jsonl",
      "analysis-2026-09-14.jsonl",
      "comparison-2026-09-14.json",
    ]);
  });

  test("reports the paths and counts it actually wrote", async () => {
    const emitted = await emit();
    expect(emitted.map((e) => e.runDate)).toEqual(["2026-09-07", "2026-09-14"]);

    for (const run of emitted) {
      expect(run.resultsPath).toBe(
        join(resultsDir, `results-${run.runDate}.jsonl`),
      );
      expect(run.analysisPath).toBe(
        join(analysisDir, `analysis-${run.runDate}.jsonl`),
      );
      const results = await parseJsonl<UnifiedResult>(run.resultsPath);
      const verdicts = await parseJsonl<ResultVerdict>(run.analysisPath);
      expect(results.length).toBe(run.resultCount);
      expect(verdicts.length).toBe(run.verdictCount);
      expect(run.resultCount).toBe(PROMPTS.length * TARGETS.length);
    }

    expect(emitted[0].comparisonPath).toBeNull();
    expect(emitted[1].comparisonPath).toBe(
      join(analysisDir, "comparison-2026-09-14.json"),
    );
  });

  test("the comparison is the shipped comparator's output, not a second one", async () => {
    // `compareWeeks` is what `bun run analyze` writes into this file. Asserting
    // against it rather than against a hand-built expectation is the point: a
    // fixture that agreed with SCHEMA.md while disagreeing with the comparator
    // would verify nothing.
    const built = corpus();
    const emitted = await emit();
    const path = emitted[1].comparisonPath;
    expect(path).not.toBeNull();

    const written = JSON.parse(await readFile(path as string, "utf-8"));
    expect(written).toEqual(
      JSON.parse(
        JSON.stringify(
          compareWeeks(
            built.runs[1].verdicts,
            built.runs[0].verdicts,
            "2026-09-14",
            "2026-09-07",
          ),
        ),
      ),
    );
    // A comparison over two real weeks of the corpus, not an empty shell.
    expect(written.deltas.length).toBeGreaterThan(0);
    expect(written.summary.totalResults).toBeGreaterThan(0);
  });

  test("records round-trip through JSONL unchanged", async () => {
    const built = corpus();
    const emitted = await emit();

    for (const [i, run] of emitted.entries()) {
      expect(await parseJsonl<UnifiedResult>(run.resultsPath)).toEqual(
        JSON.parse(JSON.stringify(built.runs[i].results)),
      );
      expect(await parseJsonl<ResultVerdict>(run.analysisPath)).toEqual(
        JSON.parse(JSON.stringify(built.runs[i].verdicts)),
      );
    }
  });

  test("every line is a self-contained JSON object — one record per line", async () => {
    const [run] = await emit();
    const text = await readFile(run.resultsPath, "utf-8");
    expect(text.endsWith("\n")).toBe(true);
    for (const line of text.split("\n").filter(Boolean)) {
      expect(line).not.toContain("\n");
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("re-emitting the same corpus reproduces the same bytes, not a second copy", async () => {
    await emit();
    const first = await snapshot();
    await emit();
    expect(await snapshot()).toEqual(first);
  });

  test("replaces a previous corpus rather than appending behind it", async () => {
    // The writers append. Left unguarded, a second `bun run seed` would stack
    // two corpora in one file and every count in the dashboard would double.
    await emit("seed-a");
    const beforeLines = (
      await readFile(join(resultsDir, "results-2026-09-14.jsonl"), "utf-8")
    )
      .split("\n")
      .filter(Boolean).length;

    await emit("seed-b");
    const afterText = await readFile(
      join(resultsDir, "results-2026-09-14.jsonl"),
      "utf-8",
    );
    expect(afterText.split("\n").filter(Boolean).length).toBe(beforeLines);
  });

  test("leaves files for other dates alone", async () => {
    const stray = join(resultsDir, "results-2020-01-01.jsonl");
    await Bun.write(stray, "{}\n");
    await emit();
    expect(await readFile(stray, "utf-8")).toBe("{}\n");
  });

  test("creates the output directories when they do not exist yet", async () => {
    await rm(dir, { recursive: true, force: true });
    const emitted = await emit();
    expect(emitted.length).toBe(2);
    expect((await readdir(analysisDir)).length).toBe(3);
  });

  test("a different seed writes the same filenames with different content", async () => {
    await emit("seed-a");
    const a = await snapshot();
    await emit("seed-b");
    const b = await snapshot();
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    for (const name of Object.keys(a)) {
      expect(b[name]).not.toBe(a[name]);
    }
  });
});

/** Every emitted file's exact bytes, keyed by path. */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of (await readdir(resultsDir)).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    out[name] = await readFile(join(resultsDir, name), "utf-8");
  }
  for (const name of (await readdir(analysisDir)).sort()) {
    out[name] = await readFile(join(analysisDir, name), "utf-8");
  }
  return out;
}
