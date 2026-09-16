import OpenAI from "openai";
import type { ProviderRunInput } from "../types/provider.js";
import type {
  Citation,
  RawSearchCall,
  SearchQuery,
  SearchResult,
  UnifiedResult,
} from "../types/unified-result.js";
import { BaseProvider } from "./base.js";

export class OpenAIProvider extends BaseProvider {
  readonly name = "openai";
  readonly displayName = "OpenAI";
  // Checked against OpenAI's model catalog on 2026-09-16: the current lineup is
  // gpt-6-astra / gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna. gpt-5.2 and
  // gpt-5.4-mini are still served but two generations behind.
  readonly supportedModels = ["gpt-5.6-terra", "gpt-5.6-luna"];

  private _client?: OpenAI;

  private get client(): OpenAI {
    this._client ??= new OpenAI();
    return this._client;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.responses.create({
        model: this.supportedModels[0],
        input: "ping",
        max_output_tokens: 10,
      });
      return true;
    } catch {
      return false;
    }
  }

  protected async execute(input: ProviderRunInput): Promise<UnifiedResult> {
    const response = await this.client.responses.create({
      model: input.model,
      tools: [{ type: "web_search_preview" }],
      input: input.prompt,
    });

    const searchQueries: SearchQuery[] = [];
    const searchResults: SearchResult[] = [];
    const citations: Citation[] = [];
    const rawSearchCalls: RawSearchCall[] = [];
    let responseText = "";
    const annotationsForRaw: unknown[] = [];

    for (const item of response.output) {
      if (item.type === "web_search_call") {
        rawSearchCalls.push({
          callIndex: rawSearchCalls.length,
          timestamp: new Date().toISOString(),
          queryText: null,
          rawInput: item,
          rawOutput: null, // will be patched with annotations below
        });
        searchQueries.push({
          query: input.prompt,
          timestamp: new Date().toISOString(),
        });
      }

      if (item.type === "message") {
        for (const content of item.content) {
          if (content.type === "output_text") {
            responseText += content.text;

            if (
              "annotations" in content &&
              Array.isArray(content.annotations)
            ) {
              annotationsForRaw.push(...content.annotations);
              for (const ann of content.annotations) {
                const a = ann as {
                  type?: string;
                  url?: string;
                  title?: string;
                  start_index?: number;
                  end_index?: number;
                };
                if (a.type === "url_citation") {
                  citations.push({
                    url: a.url ?? "",
                    title: a.title ?? "",
                    citedText:
                      a.start_index !== undefined && a.end_index !== undefined
                        ? responseText.slice(a.start_index, a.end_index)
                        : "",
                    startIndex: a.start_index,
                    endIndex: a.end_index,
                  });
                  searchResults.push({
                    url: a.url ?? "",
                    title: a.title ?? "",
                    snippet: "",
                  });
                }
              }
            }
          }
        }
      }
    }

    // Attach collected annotations as rawOutput on the search calls
    if (annotationsForRaw.length > 0) {
      for (const call of rawSearchCalls) {
        call.rawOutput = annotationsForRaw;
      }
    }

    const usage = response.usage as {
      input_tokens: number;
      output_tokens: number;
    } | null;

    return {
      id: crypto.randomUUID(),
      prompt: input.prompt,
      promptCategory: input.promptCategory,
      promptMeta: input.promptMeta,
      searchQueries,
      searchResults: dedupeByUrl(searchResults),
      responseText,
      citations,
      rawSearchCalls,
      metadata: {
        provider: this.name,
        model: input.model,
        searchTool: "web_search_preview",
        startedAt: "",
        completedAt: "",
        latencyMs: 0,
        tokenUsage: {
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
        },
        runId: input.runId,
      },
      error: null,
    };
  }
}

function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}
