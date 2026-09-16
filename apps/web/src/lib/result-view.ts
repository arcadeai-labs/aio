// Pure presentation helpers for the editorial result-detail view (issue #10).
// Kept out of the component so the formatting + graceful-emptiness rules are unit
// testable in isolation (mirrors src/lib/drilldown-view.ts). The view stays a
// thin render over `ResultDetail` from @aio/db.
import type {
  CitationDetail,
  ResultDetail,
  SearchQueryDetail,
  SearchResultDetail,
} from "@aio/db";

/** A string that survives trimming — used to detect provider-supplied blanks. */
export function hasText(value: string | null | undefined): boolean {
  return value != null && value.trim() !== "";
}

/**
 * The hostname of a URL, for compact link labels (the full URL is the href).
 * Falls back to the raw string when it isn't a parseable absolute URL — some
 * providers return bare domains or relative refs, and a broken parse should
 * degrade to showing what we have, not throw.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** "1,234ms" / "2.31s" — null when the provider reported no latency. */
export function formatLatency(ms: number | null): string | null {
  if (ms === null) return null;
  return ms < 1000 ? `${ms.toLocaleString()}ms` : `${(ms / 1000).toFixed(2)}s`;
}

/** "1,024 in / 512 out" — null when neither token count is present. */
export function formatTokens(
  input: number | null,
  output: number | null,
): string | null {
  if (input === null && output === null) return null;
  const i = input === null ? "—" : input.toLocaleString();
  const o = output === null ? "—" : output.toLocaleString();
  return `${i} in / ${o} out`;
}

/** "$0.0123" — null when no cost was estimated. */
export function formatCost(usd: number | null): string | null {
  if (usd === null) return null;
  return `$${usd.toFixed(4)}`;
}

/**
 * Citations worth showing. Some providers emit placeholder citation rows with
 * every field blank ("", null); these would render as empty bullets, so drop any
 * row with no url, title, *and* cited text. The view bases section-emptiness on
 * the filtered list so an all-placeholder array reads as "no citations".
 */
export function visibleCitations(
  citations: CitationDetail[],
): CitationDetail[] {
  return citations.filter(
    (c) => hasText(c.url) || hasText(c.title) || hasText(c.citedText),
  );
}

/** Search queries worth showing — drops blank/whitespace-only query rows. */
export function visibleQueries(
  queries: SearchQueryDetail[],
): SearchQueryDetail[] {
  return queries.filter((q) => hasText(q.query));
}

/** Search results worth showing — same blank-row guard as {@link visibleCitations}. */
export function visibleSearchResults(
  searchResults: SearchResultDetail[],
): SearchResultDetail[] {
  return searchResults.filter(
    (s) => hasText(s.url) || hasText(s.title) || hasText(s.snippet),
  );
}

export interface MetaField {
  label: string;
  value: string;
}

/**
 * The secondary "promptMeta" facts — the as-run execution context around the
 * call. Fields with no value are omitted entirely so a sparse provider (no
 * search tool, no token accounting) renders a shorter row rather than a wall of
 * em-dashes. Run / provider / model are always-present headline facts and live
 * in the component, not here.
 */
export function promptMetaFields(r: ResultDetail): MetaField[] {
  const fields: MetaField[] = [];
  if (r.location) fields.push({ label: "Location", value: r.location });
  if (!r.isRelevant) fields.push({ label: "Relevance", value: "Not relevant" });
  if (r.searchTool) fields.push({ label: "Search tool", value: r.searchTool });
  const latency = formatLatency(r.latencyMs);
  if (latency) fields.push({ label: "Latency", value: latency });
  const tokens = formatTokens(r.inputTokens, r.outputTokens);
  if (tokens) fields.push({ label: "Tokens", value: tokens });
  const cost = formatCost(r.estimatedCostUsd);
  if (cost) fields.push({ label: "Cost", value: cost });
  return fields;
}
