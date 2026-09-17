/**
 * Field-by-field comparison of two `UnifiedResult`s: one captured from the
 * *old* Perplexity chat-completions endpoint by the live `PerplexityProvider`,
 * one produced from an Agent API response by the candidate mapper.
 *
 * ── Why a bespoke comparator rather than a deep-equal ─────────────────────
 *
 * The two results answer the same prompt at different moments against a search
 * index that moves, so their *values* will never match and must not be asked
 * to. What acceptance criterion 3 actually asks is narrower and harder to fake:
 * did each field that carried data before still carry data after?
 *
 * That gives four verdicts, and the interesting one is the fourth:
 *
 *   ok          both sides carry data. The field survived.
 *   gain        baseline empty, agent populated. Not a failure — `searchQueries`
 *               is expected to do exactly this, because chat-completions never
 *               reported what it searched and the Agent API does.
 *   regression  baseline populated, agent empty. THE failure this exists to
 *               catch: an answer that reads fine with its citations silently
 *               dropped, which on this project reaches the dashboard as a
 *               confident zero rather than an error.
 *   unprovable  both sides empty. Reported as a FAILURE for the citation and
 *               search-result fields, and this is deliberate. Two empties are
 *               not evidence that extraction survived; they are evidence the
 *               baseline was worthless for the comparison. Scoring that green
 *               would be the exact bug this repo keeps writing down.
 *
 * `unprovable` on a field that is empty by design today (`searchQueries` on the
 * baseline, when the agent side is also empty) is a real failure too: it means
 * the Agent API did not report its searches either, and the mapping table entry
 * is wrong.
 */

import type { UnifiedResult } from "../types/unified-result.js";

export type FieldVerdict = "ok" | "gain" | "regression" | "unprovable";

export interface FieldComparison {
  /** Dotted path into `UnifiedResult`, e.g. `metadata.tokenUsage.inputTokens`. */
  field: string;
  verdict: FieldVerdict;
  /** Pass/fail for the process exit code. */
  passed: boolean;
  /** What was measured on each side — counts and excerpts, never whole payloads. */
  baseline: string;
  agent: string;
  /** Why this verdict, in one line a human can act on. */
  note: string;
}

export interface ComparisonReport {
  fields: FieldComparison[];
  /** Keys present on one `UnifiedResult` but not the other. Must be empty. */
  shapeDifferences: string[];
  passed: boolean;
}

/**
 * Keys the contract marks optional. Their presence may legitimately differ
 * between two results — `estimatedCostUsd` in particular is absent from the
 * chat-completions path and present on the Agent API path — so they are
 * excluded from the shape-identity check while every required key is not.
 */
const OPTIONAL_TOP_LEVEL = new Set([
  "promptCategory",
  "promptMeta",
  "rawSearchCalls",
]);
const OPTIONAL_METADATA = new Set(["estimatedCostUsd", "providerMeta"]);

function requiredKeys(obj: object, optional: Set<string>): string[] {
  return Object.keys(obj)
    .filter((k) => !optional.has(k))
    .sort();
}

/**
 * Assert the two results are the same *shape*, which is acceptance criterion 4
 * ("`UnifiedResult` shape is unchanged; no downstream or `SCHEMA.md` change is
 * required") reduced to something a machine can check. Compares required keys
 * at the top level and inside `metadata`; ignores optional keys, whose presence
 * is allowed to differ.
 */
export function compareShape(
  baseline: UnifiedResult,
  agent: UnifiedResult,
): string[] {
  const differences: string[] = [];

  const b = requiredKeys(baseline, OPTIONAL_TOP_LEVEL);
  const a = requiredKeys(agent, OPTIONAL_TOP_LEVEL);
  for (const k of b)
    if (!a.includes(k)) differences.push(`missing on agent: ${k}`);
  for (const k of a)
    if (!b.includes(k)) differences.push(`extra on agent: ${k}`);

  const bm = requiredKeys(baseline.metadata, OPTIONAL_METADATA);
  const am = requiredKeys(agent.metadata, OPTIONAL_METADATA);
  for (const k of bm)
    if (!am.includes(k)) differences.push(`missing on agent: metadata.${k}`);
  for (const k of am)
    if (!bm.includes(k)) differences.push(`extra on agent: metadata.${k}`);

  return differences;
}

interface FieldSpec {
  field: string;
  /** How many items / how much data this field carries. 0 means empty. */
  size: (r: UnifiedResult) => number;
  /** Human-readable evidence. Excerpts, never counts alone — see DESIGN.md. */
  describe: (r: UnifiedResult) => string;
  /**
   * When true, both-sides-empty is `unprovable` and FAILS: the field is the
   * point of the comparison and two zeros prove nothing.
   */
  mustProve: boolean;
}

function excerpt(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const FIELDS: FieldSpec[] = [
  {
    field: "responseText",
    size: (r) => r.responseText.trim().length,
    describe: (r) =>
      r.responseText.trim().length === 0
        ? "empty"
        : `${r.responseText.length} chars — "${excerpt(r.responseText)}"`,
    mustProve: true,
  },
  {
    field: "searchResults",
    size: (r) => r.searchResults.length,
    describe: (r) =>
      r.searchResults.length === 0
        ? "none"
        : `${r.searchResults.length} results — first: ${r.searchResults[0].url}`,
    mustProve: true,
  },
  {
    field: "searchResults[].title",
    size: (r) => r.searchResults.filter((s) => s.title.trim() !== "").length,
    describe: (r) => {
      const titled = r.searchResults.filter((s) => s.title.trim() !== "");
      return titled.length === 0
        ? "no titles"
        : `${titled.length}/${r.searchResults.length} titled — "${excerpt(titled[0].title)}"`;
    },
    mustProve: true,
  },
  {
    field: "searchResults[].snippet",
    size: (r) => r.searchResults.filter((s) => s.snippet.trim() !== "").length,
    describe: (r) => {
      const snipped = r.searchResults.filter((s) => s.snippet.trim() !== "");
      return snipped.length === 0
        ? "no snippets"
        : `${snipped.length}/${r.searchResults.length} with snippet — "${excerpt(snipped[0].snippet)}"`;
    },
    mustProve: true,
  },
  {
    field: "citations",
    size: (r) => r.citations.length,
    describe: (r) =>
      r.citations.length === 0
        ? "none"
        : `${r.citations.length} citations — first: ${r.citations[0].url}`,
    mustProve: true,
  },
  {
    field: "citations[].startIndex",
    size: (r) => r.citations.filter((c) => c.startIndex !== undefined).length,
    describe: (r) => {
      const n = r.citations.filter((c) => c.startIndex !== undefined).length;
      return n === 0 ? "no offsets" : `${n}/${r.citations.length} with offsets`;
    },
    // Chat-completions never carried offsets, so both-empty here would just
    // mean the Agent API does not either. Informational, not a gate.
    mustProve: false,
  },
  {
    field: "searchQueries",
    size: (r) => r.searchQueries.length,
    describe: (r) =>
      r.searchQueries.length === 0
        ? "none"
        : `${r.searchQueries.length} queries — first: "${excerpt(r.searchQueries[0].query)}"`,
    // Baseline is hard-coded `[]`, so this can only ever be `gain` or
    // `unprovable`. It is a gate because the mapping table claims the Agent API
    // reports its searches; if it does not, that claim is wrong.
    mustProve: true,
  },
  {
    field: "rawSearchCalls",
    size: (r) => r.rawSearchCalls?.length ?? 0,
    describe: (r) =>
      (r.rawSearchCalls?.length ?? 0) === 0
        ? "none"
        : `${r.rawSearchCalls?.length} call(s)`,
    mustProve: true,
  },
  {
    field: "metadata.tokenUsage.inputTokens",
    size: (r) => r.metadata.tokenUsage.inputTokens ?? 0,
    describe: (r) => String(r.metadata.tokenUsage.inputTokens ?? "absent"),
    mustProve: true,
  },
  {
    field: "metadata.tokenUsage.outputTokens",
    size: (r) => r.metadata.tokenUsage.outputTokens ?? 0,
    describe: (r) => String(r.metadata.tokenUsage.outputTokens ?? "absent"),
    mustProve: true,
  },
];

/**
 * `error` does not fit the size model, and forcing it in there scores an errored
 * baseline as a "gain" — the agent side got cleaner! — which is nonsense. An
 * error on *either* side fails: an errored agent means the migration does not
 * work, and an errored baseline means there is nothing to compare against and
 * the perishable capture has to be retried before the sunset.
 */
function compareError(
  baseline: UnifiedResult,
  agent: UnifiedResult,
): FieldComparison {
  const describe = (r: UnifiedResult) =>
    r.error === null ? "null" : `${r.error.code}: ${excerpt(r.error.message)}`;
  const clean = baseline.error === null && agent.error === null;
  return {
    field: "error",
    verdict: clean ? "ok" : "regression",
    passed: clean,
    baseline: describe(baseline),
    agent: describe(agent),
    note: clean
      ? "both calls succeeded"
      : baseline.error !== null
        ? "the baseline call itself errored — there is nothing to compare against, and this capture cannot be retried after 2026-09-27"
        : "the Agent API call errored",
  };
}

export function compareResults(
  baseline: UnifiedResult,
  agent: UnifiedResult,
): ComparisonReport {
  const fields: FieldComparison[] = FIELDS.map((spec) => {
    const b = spec.size(baseline);
    const a = spec.size(agent);

    let verdict: FieldVerdict;
    let note: string;
    if (b > 0 && a > 0) {
      verdict = "ok";
      note = "carried data before and after";
    } else if (b === 0 && a > 0) {
      verdict = "gain";
      note = "absent from chat-completions, populated by the Agent API";
    } else if (b > 0 && a === 0) {
      verdict = "regression";
      note = "the old endpoint carried this and the Agent API did not";
    } else {
      verdict = "unprovable";
      note = spec.mustProve
        ? "both sides empty — this proves nothing, and a zero here is indistinguishable from a working extractor on a quiet prompt"
        : "both sides empty — informational only";
    }

    const passed =
      verdict === "ok" ||
      verdict === "gain" ||
      (verdict === "unprovable" && !spec.mustProve);

    return {
      field: spec.field,
      verdict,
      passed,
      baseline: spec.describe(baseline),
      agent: spec.describe(agent),
      note,
    };
  });

  fields.push(compareError(baseline, agent));

  const shapeDifferences = compareShape(baseline, agent);

  return {
    fields,
    shapeDifferences,
    passed: fields.every((f) => f.passed) && shapeDifferences.length === 0,
  };
}
