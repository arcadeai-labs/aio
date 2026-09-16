import Exa from "exa-js";
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

export class ExaProvider extends BaseProvider {
  readonly name = "exa";
  readonly displayName = "Exa Search";
  readonly supportedModels = ["exa-auto"];

  private _exa?: Exa;

  private get exa(): Exa {
    this._exa ??= new Exa(process.env.EXA_API_KEY);
    return this._exa;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.exa.searchAndContents("test", {
        text: true,
        numResults: 1,
      });
      return true;
    } catch {
      return false;
    }
  }

  protected async execute(input: ProviderRunInput): Promise<UnifiedResult> {
    const synthesisProvider =
      (input.options?.synthesisProvider as string) ?? "openai";
    // Keep this default in step with DEFAULT_TARGETS' exa entry: a target file
    // that omits synthesisModel must not quietly run a different model from the
    // one the default matrix declares.
    const synthesisModel =
      (input.options?.synthesisModel as string) ?? "gpt-5.6-luna";

    // Phase 1: Exa search
    const exaResults = await this.exa.searchAndContents(input.prompt, {
      text: true,
      highlights: true,
      numResults: 10,
    });

    const searchQueries: SearchQuery[] = [
      { query: input.prompt, timestamp: new Date().toISOString() },
    ];

    const searchResults: SearchResult[] = exaResults.results.map((r) => ({
      url: r.url,
      title: r.title ?? "",
      snippet: r.text?.slice(0, 500) ?? "",
      score: r.score,
      pageDate: r.publishedDate ?? undefined,
    }));

    // Phase 2: LLM synthesis
    const context = exaResults.results
      .map(
        (r, i) =>
          `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.text?.slice(0, 1000) ?? ""}`,
      )
      .join("\n\n");

    const synthesisPrompt = `Based on the following search results, answer this question: ${input.prompt}\n\nSearch Results:\n${context}\n\nProvide a comprehensive answer with citations in [N] format referring to the source numbers above.`;

    const llmClient = createSynthesisClient(synthesisProvider);
    const llmResponse = await llmClient.chat.completions.create({
      model: synthesisModel,
      messages: [{ role: "user", content: synthesisPrompt }],
    });

    const responseText = llmResponse.choices[0]?.message?.content ?? "";

    // Extract inline [N] citations
    const citations: Citation[] = [];
    const citationPattern = /\[(\d+)\]/g;
    const seenIndices = new Set<number>();
    let match = citationPattern.exec(responseText);
    for (; match !== null; match = citationPattern.exec(responseText)) {
      const idx = Number.parseInt(match[1], 10) - 1;
      if (idx >= 0 && idx < searchResults.length && !seenIndices.has(idx)) {
        seenIndices.add(idx);
        citations.push({
          url: searchResults[idx].url,
          title: searchResults[idx].title,
          citedText: searchResults[idx].snippet,
        });
      }
    }

    const rawSearchCalls: RawSearchCall[] = [
      {
        callIndex: 0,
        timestamp: new Date().toISOString(),
        queryText: input.prompt,
        rawInput: {
          prompt: input.prompt,
          text: true,
          highlights: true,
          numResults: 10,
        },
        rawOutput: exaResults,
      },
    ];

    const llmUsage = llmResponse.usage;

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
        model: `exa+${synthesisModel}`,
        searchTool: "exa-search",
        startedAt: "",
        completedAt: "",
        latencyMs: 0,
        tokenUsage: {
          inputTokens: llmUsage?.prompt_tokens,
          outputTokens: llmUsage?.completion_tokens,
          searchRequests: 1,
        },
        runId: input.runId,
        providerMeta: {
          synthesisProvider,
          synthesisModel,
          exaResultCount: exaResults.results.length,
        },
      },
      error: null,
    };
  }
}

function createSynthesisClient(provider: string): OpenAI {
  switch (provider) {
    case "openai":
      return new OpenAI();
    case "openrouter":
      return new OpenAI({
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: process.env.OPENROUTER_API_KEY,
      });
    case "perplexity":
      return new OpenAI({
        baseURL: "https://api.perplexity.ai",
        apiKey: process.env.PERPLEXITY_API_KEY,
      });
    default:
      return new OpenAI();
  }
}
