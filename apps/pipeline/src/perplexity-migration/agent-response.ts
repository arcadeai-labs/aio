/**
 * Perplexity Agent API response types, and a *candidate* mapping from that
 * response onto `UnifiedResult`.
 *
 * ── What this is, and what it is not ──────────────────────────────────────
 *
 * This is scaffolding for the #16 validation harness
 * (`apps/pipeline/src/perplexity-migration-check.ts`). It is NOT a provider.
 * Nothing in `providers/registry.ts` imports it, `PerplexityProvider` is
 * untouched, and no run reaches this file. It exists so the harness can turn a
 * real Agent API response into a `UnifiedResult` and diff that against a
 * `UnifiedResult` produced by the *live* provider against the *old* endpoint —
 * which is the only way acceptance criterion 3 ("citations and search results
 * are extracted as before, compared against a pre-migration run") can ever be
 * checked, and the old endpoint stops serving 2026-09-27.
 *
 * The mapping below is derived from documentation read 2026-09-17, not from a
 * live call. Every field is an informed guess until the harness runs against a
 * real key. When it does, this file is either confirmed or corrected — and the
 * corrected version is what the phase-2 provider rewrite ships.
 *
 * ── Sources (all read 2026-09-17) ─────────────────────────────────────────
 *
 *   https://docs.perplexity.ai/api-reference/agent-post
 *     Response is `{ id, object, created_at, status, model, output[], usage,
 *     error }`. `output` is a typed array, one item per step: a `message` item
 *     carries the answer text, a `search_results` item carries the sources.
 *
 *   https://docs.perplexity.ai/docs/agent-api/tools
 *     `search_results` carries `queries` (the searches actually executed) and
 *     `results[]` of `{ id, url, title, snippet, date, last_updated, source }`.
 *
 *   https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/how-to
 *     Inline `[n]` markers stay in the answer text; source detail moves to the
 *     `search_results` output item. Message content carries `annotations` with
 *     `{ type, url, title, start_index, end_index }`.
 *
 * ── The three shape changes that matter ───────────────────────────────────
 *
 * 1. `citations` is gone as a top-level flat URL array. Its replacement is
 *    `annotations` on the message content, which carries character offsets the
 *    old shape never had — `Citation.startIndex`/`endIndex` have existed in the
 *    contract all along and were always `undefined` for this provider.
 *
 * 2. `search_results` moves from a top-level key to an item inside `output`,
 *    and gains `queries`. `UnifiedResult.searchQueries` is hard-coded `[]` in
 *    today's provider because chat-completions never told us what was searched.
 *    The Agent API does. That is a gain, not a regression.
 *
 * 3. `usage.prompt_tokens`/`completion_tokens` become
 *    `usage.input_tokens`/`output_tokens`, and a `cost` breakdown appears that
 *    maps onto the already-existing optional `metadata.estimatedCostUsd`.
 *
 * None of this requires a `UnifiedResult` change. See `compare.ts`, which
 * asserts the key sets are identical rather than taking that on trust.
 */

import type {
  Citation,
  RawSearchCall,
  SearchQuery,
  SearchResult,
  UnifiedResult,
} from "../types/unified-result.js";

/** One source, as it appears inside a `search_results` output item. */
export interface AgentSearchResult {
  id?: string;
  url: string;
  title?: string;
  snippet?: string;
  date?: string;
  last_updated?: string;
  source?: string;
}

/** An inline citation on message content: a span of the answer and its source. */
export interface AgentAnnotation {
  type?: string;
  url: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

export interface AgentMessageContent {
  type?: string;
  text?: string;
  annotations?: AgentAnnotation[];
}

export type AgentOutputItem =
  | {
      type: "message";
      id?: string;
      role?: string;
      status?: string;
      content?: AgentMessageContent[];
    }
  | {
      type: "search_results";
      queries?: string[];
      results?: AgentSearchResult[];
    }
  | { type: string; [key: string]: unknown };

export interface AgentUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cost?: { total_cost?: number; currency?: string };
}

export interface AgentResponse {
  id?: string;
  object?: string;
  created_at?: number;
  status?: string;
  model?: string;
  output?: AgentOutputItem[];
  usage?: AgentUsage;
  error?: { message?: string; type?: string } | null;
}

/** What the harness needs to build a `UnifiedResult` that is comparable. */
export interface AgentMappingInput {
  prompt: string;
  promptCategory?: string;
  promptMeta?: Record<string, string>;
  /** The id recorded for the week-over-week join. See the write-up: unsettled. */
  model: string;
  runId: string;
  /** `metadata.searchTool`. Free text; does not participate in the join. */
  searchTool?: string;
}

function isMessage(
  item: AgentOutputItem,
): item is Extract<AgentOutputItem, { type: "message" }> {
  return item.type === "message";
}

function isSearchResults(
  item: AgentOutputItem,
): item is Extract<AgentOutputItem, { type: "search_results" }> {
  return item.type === "search_results";
}

/**
 * Candidate mapping: Agent API response → `UnifiedResult`.
 *
 * Deliberately total — a malformed or empty response maps to an empty result
 * rather than throwing, because the harness has to be able to *report* "the
 * Agent API returned no citations" as a failed field. A throw here would look
 * like a harness bug instead of the finding it is.
 */
export function mapAgentResponseToUnified(
  response: AgentResponse,
  input: AgentMappingInput,
): UnifiedResult {
  const output = response.output ?? [];
  const timestamp = response.created_at
    ? new Date(response.created_at * 1000).toISOString()
    : new Date().toISOString();

  const messageContents = output
    .filter(isMessage)
    .flatMap((item) => item.content ?? []);

  const responseText = messageContents
    .filter((c) => typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");

  const searchBlocks = output.filter(isSearchResults);

  const searchResults: SearchResult[] = [];
  const searchQueries: SearchQuery[] = [];
  const rawSearchCalls: RawSearchCall[] = [];

  searchBlocks.forEach((block, callIndex) => {
    for (const query of block.queries ?? []) {
      searchQueries.push({ query, timestamp });
    }
    for (const r of block.results ?? []) {
      searchResults.push({
        url: r.url,
        title: r.title ?? "",
        snippet: r.snippet ?? "",
        // `date` is the source's publication date, which is what `pageDate`
        // means in the contract. `last_updated` has no home and stays in
        // rawSearchCalls, which is where the verbatim payload belongs.
        ...(r.date ? { pageDate: r.date } : {}),
      });
    }
    rawSearchCalls.push({
      callIndex,
      timestamp,
      queryText: block.queries?.[0] ?? null,
      rawInput: block.queries ? { queries: block.queries } : null,
      rawOutput: { results: block.results ?? null },
    });
  });

  // Citations come from the message annotations, which carry offsets. Where an
  // annotation names a URL we also saw in search_results, borrow that snippet
  // for `citedText` — the same fallback today's provider uses, for the same
  // reason: neither shape ships the cited span's text.
  const citations: Citation[] = [];
  for (const content of messageContents) {
    for (const a of content.annotations ?? []) {
      const match = searchResults.find((sr) => sr.url === a.url);
      citations.push({
        url: a.url,
        title: a.title ?? match?.title ?? "",
        citedText: match?.snippet ?? "",
        ...(typeof a.start_index === "number"
          ? { startIndex: a.start_index }
          : {}),
        ...(typeof a.end_index === "number" ? { endIndex: a.end_index } : {}),
      });
    }
  }

  const usage = response.usage;

  return {
    id: crypto.randomUUID(),
    prompt: input.prompt,
    promptCategory: input.promptCategory,
    promptMeta: input.promptMeta,
    searchQueries,
    searchResults,
    responseText,
    citations,
    rawSearchCalls,
    metadata: {
      provider: "perplexity",
      model: input.model,
      searchTool: input.searchTool ?? "perplexity-agent",
      startedAt: "",
      completedAt: "",
      latencyMs: 0,
      tokenUsage: {
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      },
      ...(typeof usage?.cost?.total_cost === "number"
        ? { estimatedCostUsd: usage.cost.total_cost }
        : {}),
      runId: input.runId,
    },
    error: null,
  };
}
