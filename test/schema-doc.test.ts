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
 * The body of a `### <Type>` section: everything from the heading to the next
 * heading of any level. Scoping by section is what makes the not-ingested guard
 * below trustworthy — `promptCategory` and `mentioned` each appear in two
 * tables with *different* answers (one ingested, one not), so a document-wide
 * search for either would silently check the wrong row.
 */
function sectionFor(typeName: string): string {
  const heading = `### \`${typeName}\``;
  const start = doc.indexOf(heading);
  if (start === -1) throw new Error(`SCHEMA.md has no section ${heading}`);
  const rest = doc.slice(start + heading.length);
  const end = rest.search(/^#{1,4} /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Field names from the `### <Type>` table in SCHEMA.md. Rows are
 * `| \`field\` | ... |`; the leading backticked cell is the field name, and a
 * trailing `?` marks optionality the same way the TypeScript source does.
 */
function documentedFields(typeName: string): Set<string> {
  const section = sectionFor(typeName);

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
  if (fields.size === 0)
    throw new Error(`no field rows under ### \`${typeName}\``);
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

  // Every field that exists in a shipped contract and has no destination in
  // packages/db/src/schema/analytics.ts, paired with the type whose table it
  // belongs to. A doc row that quietly gained a column name here would be
  // promising a query that cannot be written.
  //
  // The type is not decoration: `promptCategory` is ingested on `UnifiedResult`
  // (results.run_theme) and *not* ingested on `ResultVerdict`, and `mentioned`
  // is ingested on `BrandMention` (verdicts.mentioned) and *not* on
  // `CompetitorEntry`. A document-wide search for either name finds the
  // ingested row first and passes while the un-ingested one rots.
  const NOT_INGESTED: [type: string, field: string][] = [
    ["UnifiedResult", "rawSearchCalls"],
    ["RunMetadata", "runId"],
    ["RunMetadata", "providerMeta"],
    ["TokenUsage", "searchRequests"],
    ["RunError", "retryable"],
    ["RunError", "retriesAttempted"],
    ["ResultVerdict", "promptCategory"],
    ["CompetitorEntry", "mentioned"],
  ];

  for (const [type, field] of NOT_INGESTED) {
    test(`marks ${type}.${field} as reaching no column`, () => {
      const row = sectionFor(type)
        .split("\n")
        .find((l) => l.startsWith(`| \`${field}\``));
      expect(row).toBeDefined();
      expect(row).toContain("**—**");
    });
  }

  test("the same fields are ingested where they do have a column", () => {
    // The mirror of the guard above: if these ever became `**—**`, the pairs in
    // NOT_INGESTED would stop distinguishing anything and the section scoping
    // would be silently pointless.
    const ingested: [string, string, string][] = [
      ["UnifiedResult", "promptCategory", "results.run_theme"],
      ["BrandMention", "mentioned", "verdicts.mentioned"],
    ];
    for (const [type, field, column] of ingested) {
      const row = sectionFor(type)
        .split("\n")
        .find((l) => l.startsWith(`| \`${field}\``));
      expect(row).toBeDefined();
      expect(row).toContain(column);
      expect(row).not.toContain("**—**");
    }
  });
});

/**
 * The document's own statement about what it has and has not seen working.
 *
 * AC2 for issue #11 asked for every documented field to be confirmed against a
 * real ingested row. Six optional fields and the two `Learning` contracts
 * cannot be, because the credential-free seed corpus never produces them.
 * Rather than quietly document them as if they had been observed, SCHEMA.md
 * marks them † and says so. #34 extends the corpus to close the gap.
 *
 * These tests exist so that boundary cannot be erased by accident. If #34 (or
 * anything else) makes a field real, the fix is to delete its † row here and in
 * SCHEMA.md in the same change — a failure below means the document is now
 * claiming less, or more, than the corpus actually demonstrates.
 */
describe("SCHEMA.md is honest about what it has verified", () => {
  const VERIFICATION_HEADING =
    "## How much of this document is confirmed against data";

  test("carries the verification-status section", () => {
    expect(doc).toContain(VERIFICATION_HEADING);
  });

  test("points at the issue that closes the gap", () => {
    expect(doc).toContain("/issues/34");
  });

  // (type, field) pairs the seeded corpus does not populate. The row must both
  // name a real DB column — these are ingestable, just never exercised — and
  // carry the † marker that sends the reader to the verification section.
  const UNEXERCISED: [type: string, field: string, column: string][] = [
    ["RunMetadata", "estimatedCostUsd", "results.estimated_cost_usd"],
    ["SearchResult", "pageDate", "search_results.page_date"],
    ["Citation", "startIndex", "citations.start_index"],
    ["Citation", "endIndex", "citations.end_index"],
  ];

  for (const [type, field, column] of UNEXERCISED) {
    test(`${type}.${field} is marked as not exercised by the corpus`, () => {
      const row = sectionFor(type)
        .split("\n")
        .find((l) => l.startsWith(`| \`${field}\``));
      expect(row).toBeDefined();
      expect(row).toContain(column);
      expect(row).toContain("†");
    });
  }

  // promptMeta's two unexercised keys live in their own table, keyed by CSV key
  // rather than by contract field, so they are checked by section name.
  for (const key of ["location", "labels"]) {
    test(`promptMeta.${key} is marked as not exercised by the corpus`, () => {
      const start = doc.indexOf("#### `promptMeta`");
      expect(start).toBeGreaterThan(-1);
      const rest = doc.slice(start + "#### `promptMeta`".length);
      const end = rest.search(/^#{1,4} /m);
      const section = end === -1 ? rest : rest.slice(0, end);
      const row = section
        .split("\n")
        .find((l) => l.startsWith(`| \`${key}\``));
      expect(row).toBeDefined();
      expect(row).toContain("†");
    });
  }

  test("says plainly that no Learning record has been observed", () => {
    const start = doc.indexOf(VERIFICATION_HEADING);
    const section = doc.slice(start, doc.indexOf("\n## ", start + 1));
    expect(section).toContain("Learning");
    expect(section).toContain("no `Learning` record has been observed");
  });
});
