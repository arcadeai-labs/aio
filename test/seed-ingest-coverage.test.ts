import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadAnalyticsConfig } from "../apps/pipeline/src/analytics/config.js";
import { loadPrompts } from "../apps/pipeline/src/load.js";
import { createRng } from "../apps/pipeline/src/seed/rng.js";
import { buildCorpus } from "../apps/pipeline/src/seed/scenario.js";
import { DEFAULT_TARGETS } from "../apps/pipeline/src/targets.js";
import { buildRunBundle } from "../packages/ingest/src/transform.js";

/**
 * The seeded corpus, taken all the way through the **real** ingest transform.
 *
 * SCHEMA.md's strongest claim is per-field: "confirmed against an ingested
 * row". #11 could not make that claim for six optional fields, because the
 * credential-free corpus never produced them — so the document's own
 * verification section marked them † and said the only way to check them was a
 * credentialed run. #34 is the change that removes that qualifier, and this is
 * the test that holds it: every field the document promises is checked at the
 * **row** the ingester builds, not at the contract it was declared in.
 *
 * Why the row and not the contract: a field can be correct in the TypeScript
 * type, correct in the Drizzle table, and still arrive under a different column
 * name or not arrive at all. `packages/ingest/src/transform.ts` is the seam
 * where that happens, and it is the only thing under test here — `buildRunBundle`
 * is called directly rather than reimplemented, and no value is asserted.
 *
 * This is deliberately the one test in the repo that spans both packages: the
 * claim being made is about the corpus *and* the transform together, and either
 * half alone cannot make it. It needs no database — `buildRunBundle` is pure —
 * which is the whole point of criterion 5: a forker with no credentials and no
 * Postgres can run this and watch the document's fields land.
 */

const ROOT = resolve(import.meta.dir, "..");
const WEEKS = 15;

const config = await loadAnalyticsConfig(
  resolve(ROOT, "analytics.config.example.json"),
);
const prompts = await loadPrompts(resolve(ROOT, "prompts/default.csv"));

const corpus = buildCorpus(
  {
    brand: config.brand,
    prompts,
    targets: DEFAULT_TARGETS,
    anchorDate: "2026-09-14",
    weeks: WEEKS,
    judgeModel: config.judgeModel,
  },
  createRng("aio-tracer"),
);

const bundles = corpus.runs.map((run) =>
  buildRunBundle({
    runDate: run.runDate,
    results: run.results,
    verdicts: run.verdicts,
    config,
  }),
);

const rows = {
  prompts: bundles.flatMap((b) => b.prompts),
  promptLabels: bundles.flatMap((b) => b.promptLabels),
  results: bundles.flatMap((b) => b.results),
  searchResults: bundles.flatMap((b) => b.searchResults),
  citations: bundles.flatMap((b) => b.citations),
};

/**
 * A nullable column is only *exercised* when both of its states occur. Stated
 * once, so each field below reads as the same claim: some row carries a value,
 * some row carries NULL, and the field is genuinely optional in the data rather
 * than merely optional in the type.
 */
function bothWays<T>(
  column: string,
  all: T[],
  read: (row: T) => unknown,
): { column: string; populated: number; null: number } {
  const populated = all.filter((row) => read(row) !== null).length;
  const result = {
    column,
    populated,
    null: all.length - populated,
  };
  expect({ column, hasValue: populated > 0, hasNull: populated < all.length }).toEqual(
    { column, hasValue: true, hasNull: true },
  );
  return result;
}

describe("every optional field SCHEMA.md documents reaches a row, and a NULL", () => {
  test("results.estimated_cost_usd", () => {
    bothWays("results.estimated_cost_usd", rows.results, (r) => r.estimatedCostUsd);
  });

  test("results.run_theme and prompts.theme", () => {
    bothWays("results.run_theme", rows.results, (r) => r.runTheme);
    bothWays("prompts.theme", rows.prompts, (p) => p.theme);
  });

  test("results.run_branded_type and prompts.branded_type", () => {
    bothWays("results.run_branded_type", rows.results, (r) => r.runBrandedType);
    bothWays("prompts.branded_type", rows.prompts, (p) => p.brandedType);
  });

  test("prompts.location", () => {
    bothWays("prompts.location", rows.prompts, (p) => p.location);
  });

  test("search_results.score and search_results.page_date", () => {
    bothWays("search_results.score", rows.searchResults, (s) => s.score);
    bothWays("search_results.page_date", rows.searchResults, (s) => s.pageDate);
  });

  test("citations.start_index and citations.end_index", () => {
    bothWays("citations.start_index", rows.citations, (c) => c.startIndex);
    bothWays("citations.end_index", rows.citations, (c) => c.endIndex);
  });

  test("prompt_labels carries rows, and some prompts have none", () => {
    // `prompt_labels` has no nullable column to check: absence is the absence
    // of a row, which is exactly the shape that makes a LEFT JOIN drop a
    // prompt. Both states have to occur for that to be catchable.
    expect(rows.promptLabels.length).toBeGreaterThan(0);
    // One prompt row per prompt per run, so compare distinct prompt ids.
    const distinct = new Set(rows.prompts.map((p) => p.promptId));
    const labelled = new Set(rows.promptLabels.map((l) => l.promptId));
    const unlabelled = [...distinct].filter((id) => !labelled.has(id));
    expect(unlabelled.length).toBeGreaterThan(0);
    expect(labelled.size).toBeGreaterThan(unlabelled.length);
  });
});

describe("the ingest seam does what SCHEMA.md says it does", () => {
  test("a repeated label is de-duplicated into one prompt_labels row", () => {
    // The de-dup arm of `parseLabels` — split, trim, `Set` — had nothing in any
    // corpus to collapse before #34. Asserted through the transform, over the
    // corpus's own row, rather than by calling `parseLabels` on a string this
    // test made up: the question is whether the *corpus* reaches the branch.
    const perRun = bundles.map((bundle) => {
      const withRepeat = bundle.prompts.filter((prompt) => {
        const result = corpus.runs
          .flatMap((r) => r.results)
          .find((r) => prompt.text === r.prompt);
        const raw = result?.promptMeta?.labels ?? "";
        const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
        return parts.length > new Set(parts).size;
      });
      return withRepeat.map((prompt) => {
        const raw =
          corpus.runs
            .flatMap((r) => r.results)
            .find((r) => r.prompt === prompt.text)?.promptMeta?.labels ?? "";
        const written = bundle.promptLabels.filter(
          (l) => l.promptId === prompt.promptId,
        );
        return {
          commaParts: raw.split(",").filter((p) => p.trim()).length,
          rows: written.length,
          distinct: new Set(written.map((l) => l.label)).size,
        };
      });
    });

    const collapsed = perRun.flat();
    expect(collapsed.length).toBeGreaterThan(0);
    for (const entry of collapsed) {
      expect(entry.rows).toBeLessThan(entry.commaParts);
      expect(entry.rows).toBe(entry.distinct);
    }
  });

  test("every label row is trimmed and free of empty strings", () => {
    for (const row of rows.promptLabels) {
      expect(row.label).toBe(row.label.trim());
      expect(row.label.length).toBeGreaterThan(0);
    }
  });

  test("a citation offset resolves against the response_text it was ingested with", () => {
    // The offsets are only worth a column if they point at real text in the row
    // they were stored beside. Checked against `results.response_text` as the
    // transform wrote it — not against the in-memory corpus — because the
    // transform sanitises that string and an offset computed before the
    // sanitising step would be off by however many bytes it removed.
    const byId = new Map(rows.results.map((r) => [r.id, r]));
    let checked = 0;
    for (const citation of rows.citations) {
      if (citation.startIndex === null || citation.endIndex === null) continue;
      const response = byId.get(citation.resultId)?.responseText ?? "";
      expect({
        resultId: citation.resultId,
        resolved: response.slice(citation.startIndex, citation.endIndex),
      }).toEqual({
        resultId: citation.resultId,
        resolved: citation.citedText ?? "",
      });
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("the dimension a prompt lands on does not depend on which run was ingested last", () => {
    // `prompts` is upserted across runs with latest-seen classification. If the
    // corpus varied a prompt's meta between weeks, `location` and
    // `branded_type` would depend on ingest order — a value that changes with
    // how the loader happened to walk the directory.
    const byPrompt = new Map<string, string>();
    for (const prompt of rows.prompts) {
      const encoded = JSON.stringify([
        prompt.theme,
        prompt.brandedType,
        prompt.location,
      ]);
      const first = byPrompt.get(prompt.promptId);
      if (first === undefined) byPrompt.set(prompt.promptId, encoded);
      else
        expect({ prompt: prompt.text, encoded }).toEqual({
          prompt: prompt.text,
          encoded: first,
        });
    }
    expect(byPrompt.size).toBe(prompts.length);
  });
});

/**
 * The document against the rows — the check #11 asked for and could not finish,
 * now runnable with no credentials, no API keys and no Postgres.
 *
 * SCHEMA.md's coverage table quotes a populated/total figure per field. Those
 * are claims about data, and a document making claims about data that nothing
 * re-derives is how the six † fields came to be wrong in the first place: the
 * numbers were true when written and had no way to stay true. Here they are
 * recomputed from the corpus the reader would build, and compared cell by cell.
 *
 * This deliberately fails when the world model is retuned. That is the contract:
 * the table says what the corpus does, so a corpus that does something else
 * makes the table wrong, and the fix is to update the table in the same change.
 */
describe("SCHEMA.md's coverage table matches the corpus it describes", () => {
  const COVERAGE_HEADER =
    "| Field / column | Populated | Total | Who writes it |";

  /** The coverage table's data rows, as `[firstCell, populated, total]`. */
  function coverageRows(doc: string): [string, number, number][] {
    const lines = doc.split("\n");
    const start = lines.indexOf(COVERAGE_HEADER);
    if (start === -1) {
      throw new Error(`SCHEMA.md has no coverage table header: ${COVERAGE_HEADER}`);
    }
    const rows: [string, number, number][] = [];
    // +2 skips the header and the `|---|` separator beneath it.
    for (const line of lines.slice(start + 2)) {
      if (!line.startsWith("|")) break;
      const cells = line.slice(1).split("|");
      const digits = (cell: string) => Number(cell.replace(/[^0-9]/g, ""));
      rows.push([cells[0].trim(), digits(cells[1]), digits(cells[2])]);
    }
    return rows;
  }

  const distinctPrompts = new Set(rows.prompts.map((p) => p.promptId));
  const labelled = new Set(rows.promptLabels.map((l) => l.promptId));
  const populated = <T>(all: T[], read: (row: T) => unknown): [number, number] => [
    all.filter((row) => read(row) !== null).length,
    all.length,
  ];

  /** Keyed by a column name the row must name, so a row cannot drift onto the wrong field. */
  const MEASURED: Record<string, [number, number]> = {
    "results.estimated_cost_usd": populated(rows.results, (r) => r.estimatedCostUsd),
    "search_results.score": populated(rows.searchResults, (s) => s.score),
    "search_results.page_date": populated(rows.searchResults, (s) => s.pageDate),
    "citations.start_index": populated(rows.citations, (c) => c.startIndex),
    "citations.end_index": populated(rows.citations, (c) => c.endIndex),
    "results.run_theme": populated(rows.results, (r) => r.runTheme),
    "results.run_branded_type": populated(rows.results, (r) => r.runBrandedType),
    "prompts.location": [
      new Set(
        rows.prompts.filter((p) => p.location !== null).map((p) => p.promptId),
      ).size,
      distinctPrompts.size,
    ],
    prompt_labels: [labelled.size, distinctPrompts.size],
    "tokenUsage.inputTokens": populated(rows.results, (r) => r.inputTokens),
  };

  test("every field in the table quotes the count the corpus actually produces", async () => {
    const doc = await Bun.file(resolve(ROOT, "SCHEMA.md")).text();
    const table = coverageRows(doc);
    expect(table.length).toBe(Object.keys(MEASURED).length);

    const matched = new Set<string>();
    for (const [field, quotedPopulated, quotedTotal] of table) {
      const key = Object.keys(MEASURED).find((k) => field.includes(k));
      expect({ field, recognised: key !== undefined }).toEqual({
        field,
        recognised: true,
      });
      matched.add(key as string);
      expect({
        field,
        populated: quotedPopulated,
        total: quotedTotal,
      }).toEqual({
        field,
        populated: MEASURED[key as string][0],
        total: MEASURED[key as string][1],
      });
    }

    // Every field this test knows how to measure has a row. A row deleted from
    // the document would otherwise pass unnoticed.
    expect([...matched].sort()).toEqual(Object.keys(MEASURED).sort());
  });

  test("no field in the table is fully populated or fully NULL", () => {
    // The table's own premise. A row reading `1,440 / 1,440` would be a field
    // documented as optional and demonstrated as mandatory.
    for (const [key, [pop, total]] of Object.entries(MEASURED)) {
      expect({ key, exercised: pop > 0 && pop < total }).toEqual({
        key,
        exercised: true,
      });
    }
  });
});
