import { describe, expect, test } from "bun:test";

// Smoke tests: the monorepo move (src/ -> apps/pipeline/src/) and the type
// extraction into @aio/core must not break module resolution. Importing each
// library module exercises its full relative + workspace import graph.
// Entrypoint modules (index, rerun-failed, run-missing, analytics/index,
// gsheet, spreadsheet) are intentionally excluded — they execute on import.

const LIBRARY_MODULES = [
  "../src/load.js",
  "../src/targets.js",
  "../src/runner.js",
  "../src/providers/registry.js",
  "../src/providers/base.js",
  "../src/storage/index.js",
  "../src/util/csv-loader.js",
  "../src/util/logger.js",
  "../src/util/retry.js",
  "../src/analytics/config.js",
  "../src/analytics/loader.js",
  "../src/analytics/comparator.js",
  "../src/analytics/analyzer.js",
  "../src/analytics/judge.js",
  "../src/analytics/judge-prompt.js",
  "../src/analytics/reporter.js",
  "../src/analytics/sheets-client.js",
  "../src/analytics/types.js",
];

describe("module resolution", () => {
  for (const mod of LIBRARY_MODULES) {
    test(`imports ${mod} without throwing`, async () => {
      const imported = await import(mod);
      expect(imported).toBeDefined();
    });
  }

  test("@aio/core data-contract types resolve through the pipeline shim", async () => {
    // Type-only module: resolves to an object (no runtime exports) but must
    // not throw — proves the @aio/core workspace link is wired.
    const mod = await import("../src/types/unified-result.js");
    expect(mod).toBeDefined();
  });
});
