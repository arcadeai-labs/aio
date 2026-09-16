import type { ProviderAdapter, ProviderRunInput } from "../types/provider.js";
import type { RunError, UnifiedResult } from "../types/unified-result.js";
import { logger } from "../util/logger.js";
import { withRetry } from "../util/retry.js";

export abstract class BaseProvider implements ProviderAdapter {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly supportedModels: string[];

  protected abstract execute(input: ProviderRunInput): Promise<UnifiedResult>;
  abstract healthCheck(): Promise<boolean>;

  async run(input: ProviderRunInput): Promise<UnifiedResult> {
    const startedAt = new Date().toISOString();
    const start = performance.now();

    try {
      const { result, retriesAttempted } = await withRetry(
        () => this.execute(input),
        { maxRetries: 2 },
      );

      const completedAt = new Date().toISOString();
      const latencyMs = Math.round(performance.now() - start);

      result.metadata.startedAt = startedAt;
      result.metadata.completedAt = completedAt;
      result.metadata.latencyMs = latencyMs;

      if (retriesAttempted > 0) {
        result.metadata.providerMeta = {
          ...result.metadata.providerMeta,
          retriesAttempted,
        };
      }

      logger.info(
        {
          provider: this.name,
          model: input.model,
          latencyMs,
          tokens: result.metadata.tokenUsage,
        },
        "Provider run completed",
      );

      return result;
    } catch (err) {
      const completedAt = new Date().toISOString();
      const latencyMs = Math.round(performance.now() - start);

      const error: RunError = {
        code: extractErrorCode(err),
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
        retriesAttempted: 2,
      };

      logger.error(
        { provider: this.name, model: input.model, error: error.message },
        "Provider run failed",
      );

      return {
        id: crypto.randomUUID(),
        prompt: input.prompt,
        promptCategory: input.promptCategory,
        promptMeta: input.promptMeta,
        searchQueries: [],
        searchResults: [],
        responseText: "",
        citations: [],
        metadata: {
          provider: this.name,
          model: input.model,
          searchTool: this.name,
          startedAt,
          completedAt,
          latencyMs,
          tokenUsage: {},
          runId: input.runId,
        },
        error,
      };
    }
  }
}

function extractErrorCode(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    if ("status" in err) return `HTTP_${(err as { status: number }).status}`;
    if ("code" in err) return String((err as { code: string }).code);
  }
  return "UNKNOWN";
}
