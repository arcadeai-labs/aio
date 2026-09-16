import type { UnifiedResult } from "./unified-result.js";

export interface ProviderRunInput {
  prompt: string;
  promptCategory?: string;
  promptMeta?: Record<string, string>;
  model: string;
  runId: string;
  options?: Record<string, unknown>;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly supportedModels: string[];
  run(input: ProviderRunInput): Promise<UnifiedResult>;
  healthCheck(): Promise<boolean>;
}
