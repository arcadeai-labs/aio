import OpenAI from "openai";
import type { ProviderRunInput } from "../types/provider.js";
import type {
  Citation,
  RawSearchCall,
  SearchResult,
  UnifiedResult,
} from "../types/unified-result.js";
import { BaseProvider } from "./base.js";
import { requireApiKey } from "./credentials.js";

export class OpenRouterProvider extends BaseProvider {
  readonly name = "openrouter";
  readonly displayName = "OpenRouter";
  // Checked against https://openrouter.ai/api/v1/models on 2026-09-16. Note
  // OpenRouter's Anthropic ids use dots, not dashes — the previous
  // "anthropic/claude-sonnet-4-6:online" entry was never a routable id.
  readonly supportedModels = [
    "openai/gpt-5.6-terra:online",
    "anthropic/claude-sonnet-5:online",
    "google/gemini-3.1-pro-preview:online",
  ];

  private _client?: OpenAI;

  private get client(): OpenAI {
    // Resolve the key before the client exists. Handing the OpenAI SDK an
    // `undefined` apiKey lets it fall back to OPENAI_API_KEY, which would point
    // this client at OpenRouter holding OpenAI's credential — see
    // ./credentials.ts.
    this._client ??= new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: requireApiKey("OPENROUTER_API_KEY", "OpenRouter"),
    });
    return this._client;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.chat.completions.create({
        model: this.supportedModels[0],
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 10,
      });
      return true;
    } catch {
      return false;
    }
  }

  protected async execute(input: ProviderRunInput): Promise<UnifiedResult> {
    const response = await this.client.chat.completions.create({
      model: input.model,
      messages: [{ role: "user", content: input.prompt }],
    });

    // OpenRouter can return HTTP 200 with an `{ error: ... }` body (and no
    // `choices`) when the upstream provider errors out or moderates the
    // request. Surface that as the real error instead of crashing on
    // `response.choices[0]` with an opaque TypeError.
    if (!response.choices || response.choices.length === 0) {
      const orError = (
        response as { error?: { message?: string; code?: string | number } }
      ).error;
      const message = orError?.message ?? "OpenRouter returned no choices";
      throw Object.assign(new Error(message), { code: orError?.code });
    }

    const choice = response.choices[0];
    const responseText = choice?.message?.content ?? "";
    const citations: Citation[] = [];
    const searchResults: SearchResult[] = [];

    // OpenRouter returns annotations on the message for :online models
    const message = choice?.message as {
      content: string | null;
      annotations?: Array<{
        type?: string;
        url?: string;
        title?: string;
        start_index?: number;
        end_index?: number;
      }>;
    };

    if (message?.annotations) {
      for (const ann of message.annotations) {
        if (ann.type === "url_citation") {
          const citedText =
            ann.start_index !== undefined && ann.end_index !== undefined
              ? responseText.slice(ann.start_index, ann.end_index)
              : "";

          citations.push({
            url: ann.url ?? "",
            title: ann.title ?? "",
            citedText,
            startIndex: ann.start_index,
            endIndex: ann.end_index,
          });

          searchResults.push({
            url: ann.url ?? "",
            title: ann.title ?? "",
            snippet: citedText,
          });
        }
      }
    }

    const rawSearchCalls: RawSearchCall[] = [];
    if (message?.annotations && message.annotations.length > 0) {
      rawSearchCalls.push({
        callIndex: 0,
        timestamp: new Date().toISOString(),
        queryText: null,
        rawInput: null,
        rawOutput: message.annotations,
      });
    }

    const usage = response.usage;

    return {
      id: crypto.randomUUID(),
      prompt: input.prompt,
      promptCategory: input.promptCategory,
      promptMeta: input.promptMeta,
      searchQueries: [],
      searchResults: dedupeByUrl(searchResults),
      responseText,
      citations,
      rawSearchCalls,
      metadata: {
        provider: this.name,
        model: input.model,
        searchTool: "openrouter-online",
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

function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}
