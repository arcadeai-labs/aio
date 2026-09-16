export interface PromptEntry {
  prompt: string;
  category?: string;
  meta?: Record<string, string>;
}

export interface TargetEntry {
  provider: string;
  model: string;
  options?: Record<string, unknown>;
}

export interface RunConfig {
  prompts: PromptEntry[];
  targets: TargetEntry[];
  outputDir: string;
  concurrency: number;
  runId: string;
}
