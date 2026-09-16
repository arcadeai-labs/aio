import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * SCHEMA.md is the field reference a forker queries against. Nothing else in
 * `bun test` reads it, so a field renamed in the contracts — or one added and
 * never documented — would ship a document that produces confident queries
 * returning nothing. That is worse than no document: the querier blames their
 * data.
 *
 * These tests parse the real SCHEMA.md tables and the real interface
 * declarations and compare the two field-name sets exactly, in both directions.
 * Nothing is reimplemented here; a rename on either side fails the run.
 */

const ROOT = resolve(import.meta.dir, "..");

const doc = await readFile(resolve(ROOT, "SCHEMA.md"), "utf-8");

/**
 * Field names from the `### <Type>` table in SCHEMA.md. Rows are
 * `| \`field\` | ... |`; the leading backticked cell is the field name, and a
 * trailing `?` marks optionality the same way the TypeScript source does.
 */
function documentedFields(typeName: string): Set<string> {
  const heading = `### \`${typeName}\``;
  const start = doc.indexOf(heading);
  if (start === -1) throw new Error(`SCHEMA.md has no section ${heading}`);
  const rest = doc.slice(start + heading.length);
  const end = rest.search(/^#{1,4} /m);
  const section = end === -1 ? rest : rest.slice(0, end);

  const fields = new Set<string>();
  for (const line of section.split("\n")) {
    if (!line.startsWith("|")) continue;
    // Split on pipes that are not escaped — `\|` appears inside type unions.
    const cells = line.slice(1).split(/(?<!\\)\|/);
    const name = cells[0]?.trim().match(/^`([A-Za-z0-9_]+)`$/);
    const type = cells[1]?.trim();
    if (!name || !type?.startsWith("`")) continue;
    fields.add(`${name[1]}${type.endsWith("?`") ? "?" : ""}`);
  }
  if (fields.size === 0) throw new Error(`no field rows under ${heading}`);
  return fields;
}

/**
 * Field names from an `export interface <Type> { ... }` block. Only top-level
 * members are read: nested object literals are not used by these contracts,
 * every member sits on its own line, and comments are skipped.
 */
async function declaredFields(
  relPath: string,
  typeName: string,
): Promise<Set<string>> {
  const source = await readFile(resolve(ROOT, relPath), "utf-8");
  const start = source.indexOf(`export interface ${typeName} {`);
  if (start === -1) throw new Error(`${relPath} has no interface ${typeName}`);
  const bodyStart = source.indexOf("{", start) + 1;
  const bodyEnd = source.indexOf("\n}", bodyStart);
  const body = source.slice(bodyStart, bodyEnd);

  const fields = new Set<string>();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("*")) continue;
    const m = line.match(/^([A-Za-z0-9_]+)(\??):/);
    if (m) fields.add(`${m[1]}${m[2]}`);
  }
  if (fields.size === 0) throw new Error(`no members in ${typeName}`);
  return fields;
}

const CONTRACTS: [file: string, type: string][] = [
  ["packages/core/src/unified-result.ts", "UnifiedResult"],
  ["packages/core/src/unified-result.ts", "SearchQuery"],
  ["packages/core/src/unified-result.ts", "SearchResult"],
  ["packages/core/src/unified-result.ts", "Citation"],
  ["packages/core/src/unified-result.ts", "RunMetadata"],
  ["packages/core/src/unified-result.ts", "TokenUsage"],
  ["packages/core/src/unified-result.ts", "RawSearchCall"],
  ["packages/core/src/unified-result.ts", "RunError"],
  ["packages/core/src/verdict.ts", "ResultVerdict"],
  ["packages/core/src/verdict.ts", "BrandMention"],
  ["packages/core/src/verdict.ts", "DescriptionAccuracy"],
  ["packages/core/src/verdict.ts", "OwnedCitation"],
  ["packages/core/src/verdict.ts", "CompetitivePosition"],
  ["packages/core/src/verdict.ts", "CompetitorEntry"],
  ["packages/core/src/verdict.ts", "JudgeTokens"],
  ["apps/pipeline/src/analytics/types.ts", "ResultDelta"],
  ["apps/pipeline/src/analytics/types.ts", "WeekComparisonSummary"],
  ["apps/pipeline/src/analytics/types.ts", "WeekComparison"],
  ["packages/core/src/learning.ts", "Learning"],
  ["packages/core/src/learning.ts", "LearningEvidence"],
];

describe("SCHEMA.md documents every shipped data contract", () => {
  for (const [file, type] of CONTRACTS) {
    test(`${type} — documented fields and optionality match ${file}`, async () => {
      const declared = await declaredFields(file, type);
      expect([...documentedFields(type)].sort()).toEqual([...declared].sort());
    });
  }
});

describe("SCHEMA.md states the ingest seam", () => {
  test("names every table the ingest transform writes", () => {
    const tables = [
      "prompts",
      "prompt_labels",
      "results",
      "search_queries",
      "search_results",
      "citations",
      "verdicts",
      "verdict_excerpts",
      "verdict_owned_urls",
      "competitor_mentions",
      "competitor_cited_urls",
    ];
    const missing = tables.filter((t) => !doc.includes(t));
    expect(missing).toEqual([]);
  });

  test("marks the fields that reach no column as not ingested", () => {
    // Each of these exists in a shipped contract and has no destination in
    // packages/db/src/schema/analytics.ts. A doc row that quietly gains a
    // column name here would be promising a query that cannot be written.
    for (const field of [
      "rawSearchCalls",
      "runId",
      "providerMeta",
      "searchRequests",
      "retryable",
      "retriesAttempted",
    ]) {
      const row = doc
        .split("\n")
        .find((l) => l.startsWith(`| \`${field}\``));
      expect(row).toBeDefined();
      expect(row).toContain("**—**");
    }
  });
});
