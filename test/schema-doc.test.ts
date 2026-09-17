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
 * The body of a section: everything from `heading` to the next heading of any
 * level. `heading` must be the literal markdown heading line, so a guard cannot
 * be satisfied by the same words appearing in prose.
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
 * real ingested row. Six optional fields and the two `Learning` contracts could
 * not be, because the credential-free seed corpus never produced them, and
 * SCHEMA.md marked them † rather than document them as if they had been
 * observed. **#34 extended the corpus, and those six are now real** — so the †
 * guards that pinned them were deleted here in the same change that made them
 * false, which is exactly what SCHEMA.md said would happen.
 *
 * What replaces them is the mirror claim, with the same teeth: each of the six
 * now names a real column and carries **no** † marker, so the document cannot
 * quietly slide back to hedging about a field the corpus demonstrably produces.
 * The one remaining gap — `Learning` — is guarded by name *and* by its reason,
 * so it cannot be erased either.
 *
 * The counts those rows quote are checked against the corpus itself, in
 * `test/seed-ingest-coverage.test.ts`. This file only parses the document.
 */
describe("SCHEMA.md is honest about what it has verified", () => {
  const VERIFICATION_HEADING =
    "## How much of this document is confirmed against data";

  test("carries the verification-status section", () => {
    // sectionBody throws unless VERIFICATION_HEADING exists as a real heading
    // line; prose repeating the words is not enough.
    expect(sectionBody(VERIFICATION_HEADING).length).toBeGreaterThan(0);
  });

  test("points at the change that closed the gap, from inside that section", () => {
    // Scoped deliberately. `expect(doc).toContain("/issues/34")` — what this
    // was in round 2 — passes when the link is deleted from the verification
    // section and added anywhere else in the file. A reader who has just been
    // told these fields are confirmed against rows needs the provenance of that
    // claim in the same breath, so that is where the link has to be.
    expect(sectionBody(VERIFICATION_HEADING)).toContain("/issues/34");
  });

  // The fields that used to be marked †. Each must now name a real DB column
  // and carry **no** †. This is the mirror of the guard it replaced: the corpus
  // produces these, and a document that went back to hedging about them would
  // be claiming less than the data demonstrates — which is the same defect as
  // claiming more, pointed the other way.
  const FORMERLY_UNEXERCISED: [type: string, field: string, column: string][] =
    [
      ["RunMetadata", "estimatedCostUsd", "results.estimated_cost_usd"],
      ["SearchResult", "pageDate", "search_results.page_date"],
      ["SearchResult", "score", "search_results.score"],
      ["Citation", "startIndex", "citations.start_index"],
      ["Citation", "endIndex", "citations.end_index"],
    ];

  for (const [type, field, column] of FORMERLY_UNEXERCISED) {
    test(`${type}.${field} is documented as landing in a real row`, () => {
      const row = sectionFor(type)
        .split("\n")
        .find((l) => l.startsWith(`| \`${field}\``));
      expect(row).toBeDefined();
      expect(row).toContain(column);
      expect(row).not.toContain("†");
      expect(row).not.toContain("**—**");
    });
  }

  // promptMeta's two keys live in their own table, keyed by CSV key rather than
  // by contract field, so they are checked by section name.
  const PROMPT_META_KEYS: [key: string, column: string][] = [
    ["location", "prompts.location"],
    ["labels", "prompt_labels.label"],
  ];

  for (const [key, column] of PROMPT_META_KEYS) {
    test(`promptMeta.${key} is documented as landing in a real row`, () => {
      const row = sectionBody("#### `promptMeta`")
        .split("\n")
        .find((l) => l.startsWith(`| \`${key}\``));
      expect(row).toBeDefined();
      expect(row).toContain(column);
      expect(row).not.toContain("†");
    });
  }

  test("says plainly that no Learning record has been observed", () => {
    const section = sectionBody(VERIFICATION_HEADING);
    expect(section).toContain("no `Learning` record has been observed");
  });

  test("says why a Learning cannot come from the credential-free corpus", () => {
    // "Not observed" with no reason reads as an oversight someone will try to
    // fix in the seeder. It is not: the only registered generator makes a live
    // judge-model call, so the gap moves when the registry does. A reader has
    // to be told that rather than left to discover it.
    const section = sectionBody(VERIFICATION_HEADING);
    expect(section).toContain("live judge-model call");
    expect(section).toContain("credential-free generator");
  });

  test("says that WeekComparison is inside the seeded corpus's reach", () => {
    // The other half of the same question, answered the other way — and only
    // true because `bun run seed` writes that file through the shipped
    // comparator. If it stopped, this sentence is the lie left behind.
    const section = sectionBody(VERIFICATION_HEADING);
    expect(section).toContain("comparison-YYYY-MM-DD.json");
    expect(section).toContain("compareWeeks");
  });
});

/**
 * Two guards on this file itself.
 *
 * The same defect has now landed twice: round 1 searched the whole document for
 * a field row and checked the wrong one; round 2 fixed that, then asserted
 * `expect(doc).toContain("/issues/34")` two screens below the fix. Both passed
 * review once. The failure is not carelessness about one string — it is that
 * `doc` is in scope at every assertion site, so the unscoped version is always
 * the shortest thing to write.
 *
 * `sectionBody` is the contract, and it is the real protection: assertions
 * anchor to a heading line, and a guard that genuinely needs whole-document
 * reach belongs in `sectionBody`'s contract — widen that deliberately rather
 * than reaching around it here.
 *
 * The two guards below are a speed bump on the way past that contract, not a
 * fence around it. They catch the common shapes, which are the two that
 * actually got written: a bare `expect(doc…)` at an assertion site, and a
 * `doc.<method>` read outside the two sanctioned readers.
 *
 * An alias defeats both, and is deliberately not chased. `const raw = doc`
 * followed by `expect(raw).toContain(…)` passes the first guard, which matches
 * only `expect(doc`, and the second, which collects only `doc.<method>`. So do
 * `doc.slice(0)`, a destructure, and a one-line helper that returns the
 * document. Banning a source pattern by regex has unbounded escapes, so closing
 * the two we happen to know about would leave the class open while these guards
 * implied it was shut — worse than not guarding, because it stops the next
 * person looking. Closing the class properly means an AST-level lint rule that
 * follows the binding, not a regex over source text; that is separate work and
 * is not attempted here.
 */
describe("this test file cannot regress to document-wide assertions", () => {
  /**
   * This file's own source with comments and string literals blanked out, line
   * breaks kept so reported line numbers still point at the real line. Both
   * guards read the source, and the file necessarily names the patterns they
   * ban — in the docblock above, in a failure message, and in its own path,
   * which contains the substring `doc.test`.
   *
   * The quote characters below are written as `\x22` and `\x60` escapes so that
   * these regex literals contain none themselves. Spelled literally, the first
   * one holds an odd number of quotes, and this crude lexer reads the leftover
   * as an unterminated string that swallows the rest of the file.
   */
  const codeOnly = (source: string): string => {
    const keepLines = (match: string) =>
      "\n".repeat(match.split("\n").length - 1);
    return source
      .replace(/\/\*[\s\S]*?\*\//g, keepLines)
      .replace(/^[ \t]*\/\/.*$/gm, "")
      .replace(/\x22(?:[^\x22\\\n]|\\.)*\x22/g, "\x22\x22")
      .replace(/\x60(?:[^\x60\\]|\\.)*\x60/g, (m) => `\x60${keepLines(m)}\x60`);
  };

  const SELF = "test/schema-doc.test.ts";

  /**
   * Catches the bare shape — `expect(doc…)` at an assertion site — which is
   * what round 2 shipped. An alias is not caught; see above.
   */
  test("no assertion reads the raw document", async () => {
    const self = await readFile(resolve(ROOT, SELF), "utf-8");

    const offenders = codeOnly(self)
      .split("\n")
      .map((line, i) => [i + 1, line.trim()] as const)
      .filter(([, line]) => /expect\(\s*doc\b/.test(line))
      .map(
        ([n, line]) =>
          `${SELF}:${n}: ${line} — assert on sectionBody("<the heading line>"), which scopes the match to one section, not on the raw document`,
      );

    expect(offenders).toEqual([]);
  });

  /**
   * Catches the other shape — reading the document by method outside the two
   * readers meant to. An alias is not caught; see above.
   */
  test("only sectionBody and the ingest-seam scan may read the raw document", async () => {
    const self = await readFile(resolve(ROOT, SELF), "utf-8");

    // Two readers by design: sectionBody, which anchors to a heading line, and
    // the ingest-seam scan, which walks table rows across every section on
    // purpose. Anything else is a guard reaching around the helper.
    const reads = [
      ...new Set([...codeOnly(self).matchAll(/\bdoc\.\w+/g)].map((m) => m[0])),
    ];
    expect(reads.sort()).toEqual(["doc.indexOf", "doc.slice", "doc.split"]);
  });
});
