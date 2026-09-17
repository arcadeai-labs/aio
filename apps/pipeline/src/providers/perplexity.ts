import type { ProviderRunInput } from "../types/provider.js";
import type {
  Citation,
  RawSearchCall,
  SearchQuery,
  SearchResult,
  UnifiedResult,
} from "../types/unified-result.js";
import { BaseProvider } from "./base.js";
import { requireApiKey } from "./credentials.js";

/**
 * Perplexity Agent API.
 *
 * ── Why this is not chat-completions any more ─────────────────────────────
 *
 * Perplexity's docs carried "Sonar Chat Completions is now Agent API. Sonar
 * will be supported until September 27, 2026." This provider used to POST
 * `/chat/completions` through the OpenAI SDK; on that date the endpoint stops
 * being served and every scheduled run fails, for every fork of this template.
 * See #16 for the full investigation.
 *
 * The migration is a rewrite rather than a URL change: `messages` → `input`,
 * `choices[0].message.content` → a typed `output[]` array, and — the part that
 * matters most here — **web search went from always-on to opt-in**. Under
 * chat-completions every response carried sources whether you asked or not.
 * Under the Agent API you pass a `web_search` tool and *the model decides*
 * whether to call it. A request that omits the tool returns a fluent,
 * confident, uncited answer with no error, which on this project reaches the
 * dashboard as a believable 0% rather than as a failure. `execute()` therefore
 * checks the response for evidence that search ran, not the request.
 *
 * ── Why plain `fetch` and not the OpenAI SDK ──────────────────────────────
 *
 * Perplexity does accept `POST /v1/responses` as an OpenAI-SDK-compatible alias
 * for `/v1/agent`, so `client.responses.create()` is a supported path on paper.
 * It is not used here for one reason: the request shape below is the one that
 * was verified against the live API on 2026-09-17, byte for byte, and the
 * captured response is committed as a fixture
 * (`apps/pipeline/test/fixtures/perplexity-migration/`). Whether the SDK's
 * TypeScript surface passes `tools` through to Perplexity unchanged was never
 * tested. Shipping the SDK path would mean shipping an unverified transport
 * under a verified mapping — and `tools` silently not arriving is precisely the
 * silent zero described above. `fetch` keeps the wire format under this file's
 * control and identical to the evidence.
 *
 * ── The model id ──────────────────────────────────────────────────────────
 *
 * `sonar-pro` does not exist on the Agent API. Confirmed two ways on
 * 2026-09-17: absent from the 48 ids served by `GET /v1/models`, and rejected
 * by direct probe (`HTTP 400 validation failed: model "sonar-pro" is not
 * supported`). `perplexity/sonar` is the **base tier** — there is no `-pro` —
 * so the new series measures a tier below what `sonar-pro` measured. That is
 * not a cost of this design; no option preserves the `-pro` tier, because it no
 * longer exists.
 */

const AGENT_ENDPOINT = "https://api.perplexity.ai/v1/agent";

/** One source, inside a `search_results` output item. */
interface AgentSearchResult {
  id?: number | string;
  url: string;
  title?: string;
  snippet?: string;
  /** Publication date. Unreliable: present under some request shapes, absent
   * under others (measured). Absence is normal and must never become a zero. */
  date?: string;
  last_updated?: string;
  source?: string;
}

interface AgentMessageContent {
  type?: string;
  text?: string;
  /**
   * Always `[]` in practice. Measured empty on 6/6 live calls across presets,
   * explicit models and three instruction phrasings, including the migration
   * guide's own suggested wording. Declared so the reason it is unused is
   * visible here rather than rediscovered — see `citations` in `execute()`.
   */
  annotations?: unknown[];
}

type AgentOutputItem =
  | { type: "message"; content?: AgentMessageContent[] }
  | {
      type: "search_results";
      queries?: string[];
      results?: AgentSearchResult[];
    }
  | { type: string };

interface AgentResponse {
  id?: string;
  status?: string;
  model?: string;
  output?: AgentOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    tool_calls_details?: {
      search_web?: { invocation?: number };
    };
    cost?: { total_cost?: number };
  };
  error?: { message?: string; type?: string } | null;
}

/**
 * A failure this provider recognised itself, as opposed to one the transport
 * raised. `code` is what `BaseProvider` lifts into `RunError.code`.
 *
 * Deliberately carries no `status` property: `BaseProvider.extractErrorCode`
 * prefers `status` over `code`, so declaring one here (even as `undefined`)
 * would turn every semantic failure into `HTTP_undefined`.
 */
class PerplexityAgentError extends Error {
  override readonly name = "PerplexityAgentError";
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/**
 * A non-2xx from the Agent API. Carries `status` so `BaseProvider` records
 * `HTTP_401` / `HTTP_429` / … exactly as the OpenAI SDK's `APIError` did before
 * this migration — `run-summary.ts` classifies `HTTP_401` and `HTTP_403` as
 * credential failures, and `util/retry.ts` retries on `>= 500` and `429`.
 * Both of those read `status`, so it has to be a real property.
 */
class PerplexityHttpError extends PerplexityAgentError {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message, `HTTP_${status}`);
    this.status = status;
  }
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

export class PerplexityProvider extends BaseProvider {
  readonly name = "perplexity";
  readonly displayName = "Perplexity";

  /**
   * The `perplexity/*` ids `GET https://api.perplexity.ai/v1/models` served on
   * 2026-09-17, in the order that call returned them.
   *
   * The Agent API also serves 39 further ids from other vendors — `openai/*`,
   * `anthropic/*`, `google/*` and so on — and they are deliberately **not**
   * listed. This provider exists to measure what *Perplexity's* search engine
   * says about the brand. Accepting `openai/gpt-5.6-luna` here would let the
   * `perplexity` row record an OpenAI model, which both duplicates the `openai`
   * row and makes the provider column stop meaning what it says.
   *
   * `supportedModels[0]` is what `healthCheck()` probes, and
   * `test/targets.test.ts` pins it to the `DEFAULT_TARGETS` row so the two
   * cannot drift.
   */
  readonly supportedModels = [
    "perplexity/sonar",
    "perplexity/deepseek-v4-flash-0731",
    "perplexity/deepseek-v4-pro-0813",
    "perplexity/glm-5.2",
    "perplexity/glm-5.3",
    "perplexity/glm-5.3-flash",
    "perplexity/kimi-k2.7-code",
    "perplexity/kimi-k3",
    "perplexity/nemotron-3-ultra-550b-a55b",
  ];

  /**
   * Resolve the key before any request is built. Handing an SDK — or a header
   * builder — `process.env.PERPLEXITY_API_KEY` directly passes `undefined` when
   * it is unset, and the OpenAI SDK's constructor fills that from
   * `OPENAI_API_KEY`, sending one vendor's secret to another (#15). There is no
   * SDK here any more, but the property is the same and is kept on purpose:
   * fail by name, before a request exists.
   */
  private authHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${requireApiKey("PERPLEXITY_API_KEY", "Perplexity")}`,
      "content-type": "application/json",
    };
  }

  private async post(body: unknown): Promise<AgentResponse> {
    const res = await fetch(AGENT_ENDPOINT, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // The status is in the message as well as on the error because
      // `util/retry.ts` reads both, and a 429 that is only a property would
      // still retry — but a transport wrapper that loses the property would
      // silently stop retrying. Cheap belt and braces on a rate limit.
      const detail = (await res.text()).slice(0, 500);
      throw new PerplexityHttpError(
        `Perplexity Agent API request failed: HTTP ${res.status} — ${detail}`,
        res.status,
      );
    }

    return (await res.json()) as AgentResponse;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.post({
        model: this.supportedModels[0],
        input: "ping",
        max_output_tokens: 16,
      });
      // A 200 is not enough. The Agent API can answer 200 with
      // `status: "failed"`, and a health check that reports green off the HTTP
      // code alone is exactly the confident-but-meaningless signal this repo
      // keeps finding. No `tools` here on purpose: this asks "is the endpoint
      // there and is our key good", not "did search run".
      return response.status === "completed";
    } catch {
      return false;
    }
  }

  protected async execute(input: ProviderRunInput): Promise<UnifiedResult> {
    const response = await this.post({
      model: input.model,
      input: input.prompt,
      // Opt-in, and the reason this provider returns sources at all. Under
      // chat-completions search was unconditional; drop this line and every
      // result is a confident, uncited zero.
      tools: [{ type: "web_search" }],
    });

    // ── Failure shapes that arrive as HTTP 200 ────────────────────────────
    //
    // This check is written on faith, not on evidence: all six live calls made
    // during the investigation returned `status: "completed"`, and a failed
    // response could not be provoked on demand. It is here because without it
    // `BaseProvider`'s try/catch sees a resolved promise and records a
    // *successful* result with empty text — the single most likely way this
    // migration ships a silent zero. Exercised by a synthesised response in
    // `test/perplexity-provider.test.ts`.
    if (response.status !== "completed") {
      const detail = response.error?.message ?? "no error detail returned";
      throw new PerplexityAgentError(
        `Perplexity Agent API returned status "${response.status ?? "absent"}" rather than "completed": ${detail}`,
        "agent_status_not_completed",
      );
    }

    const output = response.output ?? [];
    const searchBlocks = output.filter(isSearchResults);

    // Web search is opt-in AND the model decides whether to call it, so passing
    // `tools` proves nothing — the evidence is on the response. No
    // `search_results` item at all means the model answered from parametric
    // memory, which is not a measurement of what Perplexity's *search engine*
    // says and must not be recorded as a clean result with zero citations.
    //
    // Note the distinction, which is deliberate and tested: a `search_results`
    // item that is *present but empty* means the search ran and found nothing.
    // That is a genuine zero and is recorded as a successful result.
    if (searchBlocks.length === 0) {
      throw new PerplexityAgentError(
        "Perplexity Agent API returned no search_results output item, so the model answered without searching; refusing to record an uncited answer as a result",
        "no_search_results",
      );
    }

    const responseText = output
      .filter(isMessage)
      .flatMap((item) => item.content ?? [])
      .filter((c) => typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");

    const timestamp = new Date().toISOString();

    const searchResults: SearchResult[] = [];
    const searchQueries: SearchQuery[] = [];
    const rawSearchCalls: RawSearchCall[] = [];

    searchBlocks.forEach((block, callIndex) => {
      // A real gain: chat-completions never reported what it searched, so
      // `searchQueries` was hard-coded `[]` on this provider for its whole life.
      for (const query of block.queries ?? []) {
        searchQueries.push({ query, timestamp });
      }

      for (const r of block.results ?? []) {
        searchResults.push({
          url: r.url,
          title: r.title ?? "",
          snippet: r.snippet ?? "",
          // Absent under some request shapes and present under others. Spread
          // conditionally so an absent date stays absent rather than becoming
          // an empty string that looks like data.
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

    // ── Citations ────────────────────────────────────────────────────────
    //
    // Sourced from `search_results[].url`, NOT from `content[].annotations`.
    //
    // The obvious-looking mapping is annotations, because that is where the
    // Agent API documents per-claim attribution with character offsets. It
    // produces zero citations, always: `annotations` came back `[]` on every
    // one of six live calls, across presets, explicit models and three
    // instruction phrasings including the migration guide's own wording.
    //
    // This is parity rather than a downgrade, and that was measured, not
    // assumed. On the committed pre-migration baseline the old endpoint's flat
    // `citations[]` array is byte-identical to `[...search_results[].url]` —
    // same URLs, same order — and the old provider then looked title and
    // snippet up out of `search_results` anyway. So the old `citations` *was*
    // the search-result URL list. Building it from `search_results` directly
    // reproduces the old behaviour exactly and unconditionally.
    // `test/perplexity-parity.test.ts` asserts that identity against the
    // committed baseline so a future edit back to `annotations` fails loudly.
    //
    // `startIndex`/`endIndex` stay unset. Offsets exist only on `annotations`.
    // The old path never set them either, so this is parity too — and they are
    // NOT reconstructed from the inline `[n]` markers in the answer text,
    // because the marker-to-source mapping was never verified and a wrong
    // offset is worse than an absent one.
    const citations: Citation[] = searchResults.map((sr) => ({
      url: sr.url,
      title: sr.title,
      citedText: sr.snippet,
    }));

    const usage = response.usage;
    const totalCost = usage?.cost?.total_cost;

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
        provider: this.name,
        model: input.model,
        searchTool: "perplexity-agent",
        startedAt: "",
        completedAt: "",
        latencyMs: 0,
        tokenUsage: {
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          // The server's own count of how many times it searched.
          searchRequests: usage?.tool_calls_details?.search_web?.invocation,
        },
        // Not an Agent API gain — the old endpoint returned `usage.cost` too
        // and this provider simply never read it. Mapped now because the field
        // has existed in the contract all along.
        ...(typeof totalCost === "number"
          ? { estimatedCostUsd: totalCost }
          : {}),
        runId: input.runId,
      },
      error: null,
    };
  }
}
