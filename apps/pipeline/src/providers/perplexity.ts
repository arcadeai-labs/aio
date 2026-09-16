import OpenAI from "openai";
import type { ProviderRunInput } from "../types/provider.js";
import type {
  Citation,
  RawSearchCall,
  SearchResult,
  UnifiedResult,
} from "../types/unified-result.js";
import { BaseProvider } from "./base.js";

interface PerplexitySearchResult {
  url: string;
  title: string;
  snippet?: string;
}

interface PerplexityResponse {
  id: string;
  choices: Array<{
    message: { content: string | null; role: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
  citations?: string[];
  search_results?: PerplexitySearchResult[];
}

export class PerplexityProvider extends BaseProvider {
  readonly name = "perplexity";
  readonly displayName = "Perplexity";
  readonly supportedModels = [
    "sonar-pro",
    "sonar",
    "sonar-reasoning-pro",
    "sonar-reasoning",
  ];

  private _client?: OpenAI;

  private get client(): OpenAI {
    this._client ??= new OpenAI({
      baseURL: "https://api.perplexity.ai",
      apiKey: process.env.PERPLEXITY_API_KEY,
    });
    return this._client;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.chat.completions.create({
        model: "sonar",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 10,
      });
      return true;
    } catch {
      return false;
    }
  }

  protected async execute(input: ProviderRunInput): Promise<UnifiedResult> {
    const rawResponse = await this.client.chat.completions.create({
      model: input.model,
      messages: [{ role: "user", content: input.prompt }],
    });

    // Cast to access Perplexity-specific fields not in OpenAI types
    const response = rawResponse as unknown as PerplexityResponse;

    const responseText = response.choices[0]?.message?.content ?? "";
    const searchResults: SearchResult[] = [];
    const citations: Citation[] = [];

    // Perplexity returns search_results with structured data
    if (response.search_results) {
      for (const sr of response.search_results) {
        searchResults.push({
          url: sr.url,
          title: sr.title,
          snippet: sr.snippet ?? "",
        });
      }
    }

    // citations[] is a flat URL array; inline refs are [1], [2], etc.
    if (response.citations) {
      for (let i = 0; i < response.citations.length; i++) {
        const url = response.citations[i];
        const matchingSr = searchResults.find((sr) => sr.url === url);
        citations.push({
          url,
          title: matchingSr?.title ?? "",
          citedText: matchingSr?.snippet ?? "",
        });
      }
    }

    const rawSearchCalls: RawSearchCall[] = [];
    if (response.citations || response.search_results) {
      rawSearchCalls.push({
        callIndex: 0,
        timestamp: new Date().toISOString(),
        queryText: null,
        rawInput: null,
        rawOutput: {
          citations: response.citations ?? null,
          search_results: response.search_results ?? null,
        },
      });
    }

    const usage = response.usage;

    return {
      id: crypto.randomUUID(),
      prompt: input.prompt,
      promptCategory: input.promptCategory,
      promptMeta: input.promptMeta,
      searchQueries: [],
      searchResults,
      responseText,
      citations,
      rawSearchCalls,
      metadata: {
        provider: this.name,
        model: input.model,
        searchTool: "perplexity-sonar",
        startedAt: "",
        completedAt: "",
        latencyMs: 0,
        tokenUsage: {
          inputTokens: usage?.prompt_tokens,
          outputTokens: usage?.completion_tokens,
        },
        runId: input.runId,
      },
      error: null,
    };
  }
}
