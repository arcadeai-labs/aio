import { Codex, type Usage } from "@openai/codex-sdk";
import type { ProviderRunInput } from "../types/provider.js";
import type {
  RawSearchCall,
  SearchQuery,
  UnifiedResult,
} from "../types/unified-result.js";
import { BaseProvider } from "./base.js";

export class OpenAICodexProvider extends BaseProvider {
  readonly name = "codex";
  readonly displayName = "OpenAI Codex";
  readonly supportedModels = ["o4-mini", "o3", "codex-mini"];

  private _codex?: Codex;

  private get codex(): Codex {
    this._codex ??= new Codex();
    return this._codex;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const thread = this.codex.startThread({ approvalPolicy: "never" });
      const { events } = await thread.runStreamed("ping");
      for await (const event of events) {
        if (event.type === "turn.completed") return true;
        if (event.type === "turn.failed" || event.type === "error")
          return false;
      }
      return false;
    } catch {
      return false;
    }
  }

  protected async execute(input: ProviderRunInput): Promise<UnifiedResult> {
    const thread = this.codex.startThread({
      model: input.model,
      webSearchMode: "live",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });

    const searchQueries: SearchQuery[] = [];
    const rawSearchCalls: RawSearchCall[] = [];
    let responseText = "";
    let usage: Usage | null = null;

    const { events } = await thread.runStreamed(input.prompt);

    for await (const event of events) {
      if (event.type === "item.completed") {
        if (event.item.type === "web_search") {
          searchQueries.push({
            query: event.item.query,
            timestamp: new Date().toISOString(),
          });
          rawSearchCalls.push({
            callIndex: rawSearchCalls.length,
            timestamp: new Date().toISOString(),
            queryText: event.item.query,
            rawInput: event.item,
            rawOutput: null,
          });
        }
        if (event.item.type === "agent_message") {
          responseText += event.item.text;
        }
      }

      if (event.type === "turn.completed") {
        usage = event.usage;
      }

      if (event.type === "turn.failed") {
        throw new Error(event.error.message);
      }

      if (event.type === "error") {
        throw new Error(event.message);
      }
    }

    return {
      id: crypto.randomUUID(),
      prompt: input.prompt,
      promptCategory: input.promptCategory,
      promptMeta: input.promptMeta,
      searchQueries,
      searchResults: [],
      responseText,
      citations: [],
      rawSearchCalls,
      metadata: {
        provider: this.name,
        model: input.model,
        searchTool: "codex-web-search",
        startedAt: "",
        completedAt: "",
        latencyMs: 0,
        tokenUsage: {
          inputTokens: usage?.input_tokens,
          outputTokens: usage?.output_tokens,
          searchRequests: searchQueries.length || undefined,
        },
        runId: input.runId,
      },
      error: null,
    };
  }
}
