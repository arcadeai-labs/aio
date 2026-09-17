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
 * The body of a section: everything from `heading` to the next heading of the
 * same level or shallower. `heading` must be the literal markdown heading line,
 * so a guard cannot be satisfied by the same words appearing in prose.
 *
 * **Every assertion in this file goes through here.** Scoping is the whole
 * point: a document-wide `doc.includes(x)` passes when `x` is moved to an
 * unrelated part of SCHEMA.md, which is exactly how this document will rot as
 * it is edited — text gets relocated far more often than it gets deleted. Round
 * 2 fixed that for the per-field guards and then reintroduced it for the #34
 * link; round 3 routes everything through one helper so there is no second
 * path to get it wrong.
 */
function sectionBody(heading: string): string {
  if (!/^#+ /.test(heading)) throw new Error(`not a heading: ${heading}`);

  // Anchored to line start, so the same words appearing in prose cannot
  // satisfy a guard — only the real heading line can.
  const at = doc.indexOf(`\n${heading}\n`);
  if (at === -1) throw new Error(`SCHEMA.md has no heading line: ${heading}`);

  // Stop at the *next heading of any level*. Subsections are deliberately
  // excluded: a string that belongs in a section's own prose should fail this
  // guard if it is demoted into a subsection, because that moves it away from
  // the reader who arrives at the section heading.
  const rest = doc.slice(at + heading.length + 2);
  const end = rest.search(/^#{1,6} /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The body of a `### <Type>` contract section — the tables that `promptCategory`
 * and `mentioned` each appear in twice, with *different* answers (one ingested,
 * one not). A document-wide search for either name finds the ingested row first
 * and passes while the un-ingested one rots.
 */
function sectionFor(typeName: string): string {
  return sectionBody(`### \`${typeName}\``);
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
  test("names every table the ingest transform writes, as a real destination", () => {
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

    // Round 2 asserted `doc.includes(t)`, which is vacuous: "results" and
    // "verdicts" are ordinary English words this document uses in prose on
    // nearly every page ("1,440 results", "885 unmentioned verdicts"). That
    // guard passed with *every* `results.*` and `verdicts.*` column reference
    // renamed to a table that does not exist.
    //
    // A table counts as named only if it appears **backticked inside a table
    // cell**, as `table` or `table.column` — never from running prose. The DB
    // column is the third cell in the contract tables and the second in the
    // `promptMeta` key table, so every cell but the first is scanned rather
    // than hardcoding an index per table shape.
    const destinations = new Set<string>();
    for (const line of doc.split("\n")) {
      if (!line.startsWith("|")) continue;
      const cells = line.slice(1).split(/(?<!\\)\|/);
      for (const cell of cells.slice(1)) {
        for (const [, table] of cell.matchAll(/`([a-z_]+)(?:\.[a-z_0-9]+)?`/g)) {
          destinations.add(table);
        }
      }
    }

    const missing = tables.filter((t) => !destinations.has(t));
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
    // sectionBody throws unless VERIFICATION_HEADING exists as a real heading
    // line; prose repeating the words is not enough.
    expect(sectionBody(VERIFICATION_HEADING).length).toBeGreaterThan(0);
  });

  test("points at the issue that closes the gap, from inside that section", () => {
    // Scoped deliberately. `expect(doc).toContain("/issues/34")` — what this
    // was in round 2 — passes when the link is deleted from the verification
    // section and added anywhere else in the file. The link is only useful to
    // a reader who has just read that a field is unverified, so that is where
    // it has to be.
    expect(sectionBody(VERIFICATION_HEADING)).toContain("/issues/34");
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
      const row = sectionBody("#### `promptMeta`")
        .split("\n")
        .find((l) => l.startsWith(`| \`${key}\``));
      expect(row).toBeDefined();
      expect(row).toContain("†");
    });
  }

  test("says plainly that no Learning record has been observed", () => {
    const section = sectionBody(VERIFICATION_HEADING);
    expect(section).toContain("no `Learning` record has been observed");
  });
});

/**
 * A guard on this file itself.
 *
 * The same defect has now landed twice: round 1 searched the whole document for
 * a field row and checked the wrong one; round 2 fixed that, then asserted
 * `expect(doc).toContain("/issues/34")` two screens below the fix. Both passed
 * review once. The failure is not carelessness about one string — it is that
 * `doc` is in scope at every assertion site, so the unscoped version is always
 * the shortest thing to write.
 *
 * So: assertions may not touch the raw document. Everything goes through
 * `sectionBody`, which anchors to a heading line. If a future guard genuinely
 * needs whole-document reach, it belongs in `sectionBody`'s contract — widen
 * that deliberately rather than reaching around it here.
 */
describe("this test file cannot regress to document-wide assertions", () => {
  test("no assertion reads the raw document", async () => {
    const self = await readFile(resolve(ROOT, "test/schema-doc.test.ts"), "utf-8");

    // Strip comments first — this very docblock names the banned pattern.
    const code = self
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const offenders = code
      .split("\n")
      .map((line, i) => [i + 1, line.trim()] as const)
      .filter(([, line]) => /expect\(\s*doc\b/.test(line));

    expect(offenders).toEqual([]);
  });

  test("only sectionBody and the ingest-seam scan may read the raw document", async () => {
    const self = await readFile(resolve(ROOT, "test/schema-doc.test.ts"), "utf-8");

    // Strip comments *and* string literals: this file's own path contains the
    // substring "doc.test", which would otherwise read as a document access.
    const code = self
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, "``");

    // Two readers by design: sectionBody, which anchors to a heading line, and
    // the ingest-seam scan, which walks table rows across every section on
    // purpose. Anything else is a guard reaching around the helper.
    const reads = [...new Set([...code.matchAll(/\bdoc\.\w+/g)].map((m) => m[0]))];
    expect(reads.sort()).toEqual(["doc.indexOf", "doc.slice", "doc.split"]);
  });
});
