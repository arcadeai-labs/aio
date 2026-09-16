import type { TargetEntry } from "./types/config.js";

/**
 * The default provider/model matrix used by both the main run (index.ts)
 * and the targeted failure re-run (rerun-failed.ts). Keep this as the single
 * source of truth so a re-run reconstructs the exact same target config —
 * including provider options like Exa's synthesis model, which are not stored
 * on individual result records.
 *
 * ── Audit, 2026-09-16 ──────────────────────────────────────────────────────
 *
 * Every id below was checked against the provider's own current documentation
 * or live model list on that date. Sources and what changed:
 *
 *   openai           gpt-5.2 — unchanged here; still in OpenAI's catalog and
 *                    absent from the deprecations page, so the provider does
 *                    serve it. It is two generations behind the current lineup
 *                    (gpt-6-astra / gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna).
 *
 *   anthropic        claude-sonnet-4-6 → claude-sonnet-5
 *   anthropic-agent  Anthropic's models overview lists the current lineup as
 *                    claude-fable-5-1 / claude-opus-5 / claude-sonnet-5 /
 *                    claude-haiku-4-5-20251001, with claude-sonnet-4-6 under
 *                    "Legacy models (still available)". Sonnet 5 is the direct
 *                    current equivalent of the tier that was pinned.
 *
 *   openrouter       openai/gpt-5.2:online — unchanged here, and deliberately
 *                    kept in lockstep with the `openai` row: the two rows exist
 *                    to compare the same model through OpenAI's own web search
 *                    and through OpenRouter's `:online` plugin, which only means
 *                    something if the model matches. `openai/gpt-5.2` was
 *                    confirmed present in https://openrouter.ai/api/v1/models,
 *                    and the `:online` suffix is still documented.
 *
 *   perplexity       sonar-pro — unchanged, still current.
 *                    NOTE: Perplexity's docs carry "Sonar Chat Completions is
 *                    now Agent API. Sonar will be supported until September 27,
 *                    2026." This provider talks to /chat/completions, and the
 *                    Agent API is a different request shape — moving to it is a
 *                    provider rewrite, not a model-id change. Tracked separately.
 *
 *   exa              synthesisModel gpt-5.4-mini — unchanged here; still served,
 *                    same generation caveat as the `openai` row.
 *                    `model: "exa-auto"` is a label, not a provider-served id:
 *                    Exa's search API takes no model (its mode selector is
 *                    `type: keyword|neural|auto|hybrid|fast|instant`, which this
 *                    provider leaves at the default), and the provider records
 *                    `metadata.model` as `exa+<synthesisModel>` rather than
 *                    `exa-auto`. That mismatch is deliberate and load-bearing:
 *                    the recorded id is what the week-over-week join uses, so
 *                    changing the synthesis model correctly starts a new series
 *                    instead of silently continuing the old one under a label
 *                    that no longer describes what produced the answer.
 *
 * Changing any id here ends that target's week-over-week series and starts a
 * new one — comparison matches on `(prompt, provider, model)`. That is correct,
 * but it is not free; do it deliberately and expect a gap in the trend.
 */
export const DEFAULT_TARGETS: TargetEntry[] = [
  { provider: "openai", model: "gpt-5.2" },
  { provider: "anthropic", model: "claude-sonnet-5" },
  { provider: "anthropic-agent", model: "claude-sonnet-5" },
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
