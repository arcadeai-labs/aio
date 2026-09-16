import type { ProviderAdapter } from "../types/provider.js";
import { AnthropicAgentProvider } from "./anthropic-agent.js";
import { AnthropicProvider } from "./anthropic.js";
import { ExaProvider } from "./exa.js";
import { OpenAICodexProvider } from "./openai-codex.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { PerplexityProvider } from "./perplexity.js";

const providers = new Map<string, () => ProviderAdapter>([
  ["openai", () => new OpenAIProvider()],
  ["anthropic", () => new AnthropicProvider()],
  ["anthropic-agent", () => new AnthropicAgentProvider()],
  ["openrouter", () => new OpenRouterProvider()],
  ["perplexity", () => new PerplexityProvider()],
  ["exa", () => new ExaProvider()],
  ["codex", () => new OpenAICodexProvider()],
]);

export function getProvider(name: string): ProviderAdapter {
  const factory = providers.get(name);
  if (!factory) {
    throw new Error(
      `Unknown provider: "${name}". Available: ${[...providers.keys()].join(", ")}`,
    );
  }
  return factory();
}

export function listProviders(): string[] {
  return [...providers.keys()];
}
