import Anthropic from "@anthropic-ai/sdk";
import type { ProviderRunInput } from "../types/provider.js";
import type {
  Citation,
  RawSearchCall,
  SearchQuery,
  SearchResult,
  UnifiedResult,
} from "../types/unified-result.js";
import { BaseProvider } from "./base.js";

export class AnthropicProvider extends BaseProvider {
  readonly name = "anthropic";
  readonly displayName = "Anthropic Claude";
  // Checked against Anthropic's models overview on 2026-09-16: the current
  // lineup is claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5-20251001
  // (plus claude-fable-5-1). claude-sonnet-4-6 and claude-opus-4-7 are listed
  // as legacy — still served, but a generation behind.
  readonly supportedModels = [
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-haiku-4-5-20251001",
  ];

  private _client?: Anthropic;

  private get client(): Anthropic {
    this._client ??= new Anthropic();
    return this._client;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.messages.create({
        model: this.supportedModels[0],
        max_tokens: 10,
        messages: [{ role: "user", content: "ping" }],
      });
      return true;
    } catch {
      return false;
    }
  }

  protected async execute(input: ProviderRunInput): Promise<UnifiedResult> {
    const response = await this.client.messages.create({
      model: input.model,
      max_tokens: 4096,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5,
        },
      ],
      messages: [{ role: "user", content: input.prompt }],
    });

    const searchQueries: SearchQuery[] = [];
    const searchResults: SearchResult[] = [];
    const citations: Citation[] = [];
    const rawSearchCalls: RawSearchCall[] = [];
    let responseText = "";
    let pendingInput: unknown = null;
    let pendingQuery: string | null = null;

    for (const block of response.content) {
      if (block.type === "server_tool_use" && block.name === "web_search") {
        const blockInput = block.input as { query?: string };
        pendingInput = block;
        pendingQuery = blockInput.query ?? null;
        if (blockInput.query) {
          searchQueries.push({
            query: blockInput.query,
            timestamp: new Date().toISOString(),
          });
        }
      }

      if (block.type === "web_search_tool_result") {
        rawSearchCalls.push({
          callIndex: rawSearchCalls.length,
          timestamp: new Date().toISOString(),
          queryText: pendingQuery,
          rawInput: pendingInput,
          rawOutput: block,
        });
        pendingInput = null;
        pendingQuery = null;
        if (Array.isArray(block.content)) {
          for (const item of block.content) {
            if (
              typeof item === "object" &&
              item !== null &&
              "type" in item &&
              item.type === "web_search_result"
            ) {
              const result = item as {
                url?: string;
                title?: string;
                page_age?: string;
              };
              searchResults.push({
                url: result.url ?? "",
                title: result.title ?? "",
                snippet: "",
                pageDate: result.page_age,
              });
            }
          }
        }
      }

      if (block.type === "text") {
        responseText += block.text;

        if ("citations" in block && Array.isArray(block.citations)) {
          for (const cite of block.citations) {
            const c = cite as {
              type?: string;
              url?: string;
              title?: string;
              cited_text?: string;
            };
            if (c.type === "web_search_result_location") {
              citations.push({
                url: c.url ?? "",
                title: c.title ?? "",
                citedText: c.cited_text ?? "",
              });
            }
          }
        }
      }
    }

    const usage = response.usage as {
      input_tokens: number;
      output_tokens: number;
      server_tool_use?: { web_search_requests?: number };
    };

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
        searchTool: "web_search_20250305",
        startedAt: "",
        completedAt: "",
        latencyMs: 0,
        tokenUsage: {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          searchRequests: usage.server_tool_use?.web_search_requests,
        },
        runId: input.runId,
      },
      error: null,
    };
  }
}
