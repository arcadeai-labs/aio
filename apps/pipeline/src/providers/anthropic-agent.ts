import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderRunInput } from "../types/provider.js";
import type {
  Citation,
  RawSearchCall,
  SearchQuery,
  SearchResult,
  UnifiedResult,
} from "../types/unified-result.js";
import { BaseProvider } from "./base.js";

interface WebSearchToolInput {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
}

interface WebFetchToolInput {
  url: string;
  prompt?: string;
}

// Claude's native web tools. The base toolset is restricted to exactly these
// so the agent cannot reach filesystem tools or anything else.
const NATIVE_WEB_TOOLS = ["WebSearch", "WebFetch"];

// The session must be hermetic: no filesystem settings and no MCP servers.
// strictMcpConfig is required — without it the CLI still loads MCP servers
// from the local ~/.claude config even when mcpServers is empty, which
// contaminated the 2026-07-13 run with this machine's MCP tools.
const ISOLATION_OPTIONS = {
  settingSources: [] as [],
  mcpServers: {},
  strictMcpConfig: true,
  permissionMode: "bypassPermissions" as const,
  allowDangerouslySkipPermissions: true,
};

interface TrackedToolUse {
  tool: "WebSearch" | "WebFetch";
  queryText: string;
  rawInput: unknown;
}

export class AnthropicAgentProvider extends BaseProvider {
  readonly name = "anthropic-agent";
  readonly displayName = "Anthropic (Agent SDK)";
  // Checked against Anthropic's models overview on 2026-09-16: the current
  // lineup is claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5-20251001
  // (plus claude-fable-5-1). claude-sonnet-4-6 and claude-opus-4-7 are listed
  // as legacy — still served, but a generation behind.
  readonly supportedModels = [
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-haiku-4-5-20251001",
  ];

  async healthCheck(): Promise<boolean> {
    try {
      for await (const msg of query({
        prompt: "Say 'ok'",
        options: {
          maxTurns: 1,
          tools: [],
          allowedTools: [],
          ...ISOLATION_OPTIONS,
        },
      })) {
        if (msg.type === "result") return msg.subtype === "success";
      }
      return false;
    } catch {
      return false;
    }
  }

  protected async execute(input: ProviderRunInput): Promise<UnifiedResult> {
    const searchQueries: SearchQuery[] = [];
    const searchResults: SearchResult[] = [];
    const rawSearchCalls: RawSearchCall[] = [];
    let responseText = "";
    let totalCostUsd: number | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let searchRequests = 0;
    // tool_use id → call details, so tool_result blocks are attributed to the
    // exact call they answer instead of "whatever tool_use came last".
    const trackedToolUses = new Map<string, TrackedToolUse>();

    for await (const msg of query({
      prompt: input.prompt,
      options: {
        model: input.model,
        tools: NATIVE_WEB_TOOLS,
        allowedTools: NATIVE_WEB_TOOLS,
        maxTurns: 10,
        ...ISOLATION_OPTIONS,
      },
    })) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type !== "tool_use") continue;
          if (block.name === "WebSearch") {
            const toolInput = block.input as WebSearchToolInput;
            searchQueries.push({
              query: toolInput.query,
              timestamp: new Date().toISOString(),
            });
            searchRequests++;
            trackedToolUses.set(block.id, {
              tool: "WebSearch",
              queryText: toolInput.query,
              rawInput: block.input,
            });
          } else if (block.name === "WebFetch") {
            const toolInput = block.input as WebFetchToolInput;
            trackedToolUses.set(block.id, {
              tool: "WebFetch",
              queryText: toolInput.url,
              rawInput: block.input,
            });
          }
        }
      }

      if (msg.type === "user") {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== "tool_result") continue;
            const call = trackedToolUses.get(block.tool_use_id);
            if (!call) continue;
            trackedToolUses.delete(block.tool_use_id);

            rawSearchCalls.push({
              callIndex: rawSearchCalls.length,
              timestamp: new Date().toISOString(),
              queryText: call.queryText,
              rawInput: call.rawInput,
              rawOutput: block.content,
            });

            if (call.tool === "WebSearch") {
              searchResults.push(...parseWebSearchResults(block.content));
            }
          }
        }
      }

      if (msg.type === "result") {
        if (msg.subtype === "success") {
          responseText = msg.result;
        }
        totalCostUsd = msg.total_cost_usd;
        inputTokens = msg.usage.input_tokens ?? undefined;
        outputTokens = msg.usage.output_tokens ?? undefined;
      }
    }

    // Derive citations from search results referenced in the response
    const citations: Citation[] = [];
    for (const sr of searchResults) {
      if (
        responseText.includes(sr.url) ||
        (sr.title.length > 0 && responseText.includes(sr.title))
      ) {
        citations.push({
          url: sr.url,
          title: sr.title,
          citedText: sr.snippet,
        });
      }
    }

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
        searchTool: "claude-agent-sdk-websearch",
        startedAt: "",
        completedAt: "",
        latencyMs: 0,
        tokenUsage: {
          inputTokens,
          outputTokens,
          searchRequests,
        },
        estimatedCostUsd: totalCostUsd,
        runId: input.runId,
        providerMeta: {
          sdk: "@anthropic-ai/claude-agent-sdk",
        },
      },
      error: null,
    };
  }
}

/**
 * Parse a WebSearch tool_result into search results.
 *
 * The native WebSearch tool returns a text block shaped like:
 *
 *   Web search results for query: "..."
 *
 *   Links: [{"title":"...","url":"..."}, ...]
 *
 *   <model-readable summary>
 *
 * The Links array is a single line of JSON. Entries without a string url are
 * dropped — a missing url in the results file crashes downstream analytics.
 */
function parseWebSearchResults(content: unknown): SearchResult[] {
  const texts: string[] = [];
  if (typeof content === "string") {
    texts.push(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
  }

  const results: SearchResult[] = [];
  for (const text of texts) {
    const match = text.match(/^Links:\s*(\[.*\])\s*$/m);
    if (!match?.[1]) continue;
    let links: unknown;
    try {
      links = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (!Array.isArray(links)) continue;
    for (const link of links) {
      const l = link as { url?: unknown; title?: unknown };
      if (typeof l.url !== "string" || l.url.length === 0) continue;
      results.push({
        url: l.url,
        title: typeof l.title === "string" ? l.title : "",
        snippet: "",
      });
    }
  }
  return results;
}
