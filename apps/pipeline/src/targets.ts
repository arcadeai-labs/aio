import type { TargetEntry } from "./types/config.js";

/**
 * The default provider/model matrix used by both the main run (index.ts)
 * and the targeted failure re-run (rerun-failed.ts). Keep this as the single
 * source of truth so a re-run reconstructs the exact same target config —
 * including provider options like Exa's synthesis model, which are not stored
 * on individual result records.
 */
export const DEFAULT_TARGETS: TargetEntry[] = [
  { provider: "openai", model: "gpt-5.2" },
  { provider: "anthropic", model: "claude-sonnet-4-6" },
  { provider: "anthropic-agent", model: "claude-sonnet-4-6" },
  { provider: "openrouter", model: "openai/gpt-5.2:online" },
  { provider: "perplexity", model: "sonar-pro" },
  {
    provider: "exa",
    model: "exa-auto",
    options: { synthesisProvider: "openai", synthesisModel: "gpt-5.4-mini" },
  },
];

export function targetForProvider(provider: string): TargetEntry | undefined {
  return DEFAULT_TARGETS.find((t) => t.provider === provider);
}
