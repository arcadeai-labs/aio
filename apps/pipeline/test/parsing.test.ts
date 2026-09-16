import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrompts, loadTargets } from "../src/load.js";
import { DEFAULT_TARGETS, targetForProvider } from "../src/targets.js";
import { loadCsv } from "../src/util/csv-loader.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "aio-parsing-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("csv-loader", () => {
  test("parses headers and rows", async () => {
    const file = join(dir, "basic.csv");
    await writeFile(file, "a,b,c\n1,2,3\n4,5,6\n");
    const rows = await loadCsv(file);
    expect(rows).toEqual([
      { a: "1", b: "2", c: "3" },
      { a: "4", b: "5", c: "6" },
    ]);
  });

  test("handles quoted fields containing the delimiter and escaped quotes", async () => {
    const file = join(dir, "quoted.csv");
    await writeFile(file, 'prompt,note\n"hello, world","she said ""hi"""\n');
    const rows = await loadCsv(file);
    expect(rows[0].prompt).toBe("hello, world");
    expect(rows[0].note).toBe('she said "hi"');
  });

  test("skips blank lines and returns [] for header-only files", async () => {
    const file = join(dir, "headeronly.csv");
    await writeFile(file, "a,b\n");
    expect(await loadCsv(file)).toEqual([]);
  });

  test("detects tab delimiter for .tsv", async () => {
    const file = join(dir, "data.tsv");
    await writeFile(file, "a\tb\n1\t2\n");
    expect(await loadCsv(file)).toEqual([{ a: "1", b: "2" }]);
  });
});

describe("loadPrompts", () => {
  test("filters non-relevant rows (Relevant=FALSE)", async () => {
    const file = join(dir, "relevance.csv");
    await writeFile(
      file,
      "prompt,Relevant\nkeep me,True\ndrop me,FALSE\nkeep too,\n",
    );
    const prompts = await loadPrompts(file);
    expect(prompts.map((p) => p.prompt)).toEqual(["keep me", "keep too"]);
  });

  test("remaps theme_name to category and moves branded category into meta.brandedType", async () => {
    const file = join(dir, "themed.csv");
    await writeFile(
      file,
      "prompt,category,theme_name\nQ1,Unbranded,Agent Authorization\n",
    );
    const [p] = await loadPrompts(file);
    expect(p.category).toBe("Agent Authorization");
    expect(p.meta?.brandedType).toBe("Unbranded");
  });

  test("falls back to category when theme_name is absent", async () => {
    const file = join(dir, "plain.csv");
    await writeFile(file, "prompt,category\nQ1,Unbranded\n");
    const [p] = await loadPrompts(file);
    expect(p.category).toBe("Unbranded");
    expect(p.meta?.brandedType).toBeUndefined();
  });

  test("returns [] for an empty prompt file", async () => {
    const file = join(dir, "empty.csv");
    await writeFile(file, "prompt,category\n");
    expect(await loadPrompts(file)).toEqual([]);
  });
});

describe("targets", () => {
  test("DEFAULT_TARGETS covers the six provider matrix", () => {
    const providers = DEFAULT_TARGETS.map((t) => t.provider);
    expect(providers).toEqual([
      "openai",
      "anthropic",
      "anthropic-agent",
      "openrouter",
      "perplexity",
      "exa",
    ]);
  });

  test("targetForProvider returns the entry or undefined", () => {
    expect(targetForProvider("perplexity")?.model).toBe("sonar-pro");
    expect(targetForProvider("nope")).toBeUndefined();
  });

  test("loadTargets returns DEFAULT_TARGETS when TARGETS_FILE is unset", async () => {
    const prev = process.env.TARGETS_FILE;
    // biome-ignore lint/performance/noDelete: truly unsetting an env var needs delete
    delete process.env.TARGETS_FILE;
    try {
      expect(await loadTargets()).toEqual(DEFAULT_TARGETS);
    } finally {
      if (prev !== undefined) process.env.TARGETS_FILE = prev;
    }
  });

  test("loadTargets reads and parses TARGETS_FILE when set", async () => {
    const file = join(dir, "targets.json");
    await writeFile(
      file,
      JSON.stringify([{ provider: "openai", model: "gpt-x" }]),
    );
    const prev = process.env.TARGETS_FILE;
    process.env.TARGETS_FILE = file;
    try {
      const targets = await loadTargets();
      expect(targets).toEqual([{ provider: "openai", model: "gpt-x" }]);
    } finally {
      // biome-ignore lint/performance/noDelete: truly unsetting an env var needs delete
      if (prev === undefined) delete process.env.TARGETS_FILE;
      else process.env.TARGETS_FILE = prev;
    }
  });
});
