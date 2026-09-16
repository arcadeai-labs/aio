import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnifiedResult } from "@aio/core";
import { loadAnalyticsConfig } from "../src/analytics/config.js";
import {
  findPreviousAnalysisDate,
  loadResults,
} from "../src/analytics/loader.js";
import { JsonlStore } from "../src/storage/index.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "aio-loaders-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function result(id: string): UnifiedResult {
  return {
    id,
    prompt: "Q",
    searchQueries: [],
    searchResults: [],
    responseText: "answer",
    citations: [],
    metadata: {
      provider: "openai",
      model: "gpt-5.2",
      searchTool: "web",
      startedAt: "2026-06-15T00:00:00Z",
      completedAt: "2026-06-15T00:00:01Z",
      latencyMs: 1000,
      tokenUsage: {},
      runId: "run-1",
    },
    error: null,
  };
}

describe("JsonlStore + loadResults roundtrip", () => {
  test("appends results and loads them back by date", async () => {
    const store = new JsonlStore(dir, new Date("2026-06-15T12:00:00Z"));
    await store.append(result("a"));
    await store.append(result("b"));
    expect(store.getFilePath()).toBe(join(dir, "results-2026-06-15.jsonl"));

    const loaded = await loadResults(dir, "2026-06-15");
    expect(loaded.map((r) => r.id)).toEqual(["a", "b"]);
    expect(loaded[0].metadata.provider).toBe("openai");
  });
});

describe("findPreviousAnalysisDate", () => {
  test("returns the most recent analysis date strictly before the current one", async () => {
    const d = await mkdtemp(join(tmpdir(), "aio-prevdate-"));
    try {
      for (const date of ["2026-06-01", "2026-06-08", "2026-06-15"]) {
        await writeFile(join(d, `analysis-${date}.jsonl`), "");
      }
      expect(await findPreviousAnalysisDate(d, "2026-06-15")).toBe(
        "2026-06-08",
      );
      expect(await findPreviousAnalysisDate(d, "2026-06-01")).toBeNull();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("returns null when the directory does not exist", async () => {
    expect(
      await findPreviousAnalysisDate(join(dir, "nope"), "2026-06-15"),
    ).toBeNull();
  });
});

describe("loadAnalyticsConfig", () => {
  test("parses brand config and fills defaults for omitted fields", async () => {
    const file = join(dir, "analytics.config.json");
    await writeFile(
      file,
      JSON.stringify({
        brand: { name: "Taskwell", ownedDomains: ["taskwell.app"] },
      }),
    );
    const config = await loadAnalyticsConfig(file);
    expect(config.brand.name).toBe("Taskwell");
    expect(config.brand.ownedDomains).toEqual(["taskwell.app"]);
    expect(config.brand.aliases).toEqual([]); // default
    expect(config.resultsDir).toBe("results"); // default
    expect(config.outputDir).toBe("results/analysis"); // default
    expect(config.concurrency).toBe(5); // default
  });

  test("throws when brand.name is missing", async () => {
    const file = join(dir, "bad.config.json");
    await writeFile(file, JSON.stringify({ brand: { aliases: [] } }));
    await expect(loadAnalyticsConfig(file)).rejects.toThrow(/brand\.name/);
  });
});
