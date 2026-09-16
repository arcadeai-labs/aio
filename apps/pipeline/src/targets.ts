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
 *   openai           gpt-5.2 → gpt-5.6-terra
 *                    gpt-5.2 is still in OpenAI's catalog and is not on the
 *                    deprecations page, but the current lineup is
 *                    gpt-6-astra / gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna.
 *                    terra is the "balanced intelligence and cost" tier and
 *                    lists the Responses API and web search among its
 *                    supported surfaces.
 *
 *   anthropic        claude-sonnet-4-6 → claude-sonnet-5
 *                    Anthropic's models overview lists the current lineup as
 *                    claude-fable-5-1 / claude-opus-5 / claude-sonnet-5 /
 *                    claude-haiku-4-5-20251001, with claude-sonnet-4-6 under
 *                    "Legacy models (still available)". Sonnet 5 is the direct
 *                    current equivalent of the tier that was pinned. Verified
 *                    by the credentialed run: 16/16, zero errors.
 *
 *   anthropic-agent  claude-sonnet-4-6 — DELIBERATELY LAGS THE ROW ABOVE.
 *                    This row was moved to claude-sonnet-5 alongside the API
 *                    row and the credentialed run returned 0/16, every prompt,
 *                    retries exhausted. It is reverted here, and the lag is the
 *                    point rather than an oversight:
 *
 *                    This provider does not call the Messages API. It drives
 *                    @anthropic-ai/claude-agent-sdk, which spawns the Claude
 *                    Code CLI as a subprocess — a second, independently
 *                    versioned artifact with its own model vocabulary. The
 *                    pinned SDK (0.2.50) bundles Claude Code 2.1.50, whose
 *                    binary contains no Claude 5 model string at all; the
 *                    newest id per tier it knows is claude-opus-4-6,
 *                    claude-sonnet-4-6, claude-haiku-4-5-20251001.
 *
 *                    So `anthropic` accepting claude-sonnet-5 says nothing
 *                    about this row, and its 16/16 is precisely the evidence
 *                    that misleads. claude-sonnet-4-6 is the newest id with
 *                    positive evidence behind it here — the baseline run had it
 *                    at 16/16 on this same SDK version.
 *
 *                    This is a dependency bound, not a wrong id: the ceiling is
 *                    `"@anthropic-ai/claude-agent-sdk": "^0.2.50"` in
 *                    apps/pipeline/package.json, and ^0.2.x cannot reach a
 *                    build that knows Claude 5. Moving this row forward means
 *                    widening that range, which is tracked in #17 and is its
 *                    own change with its own verification — not a string edit
 *                    here. Re-sync this row with the one above only after #17
 *                    lands and a credentialed run proves it.
 *
 *   openrouter       openai/gpt-5.2:online → openai/gpt-5.6-terra:online
 *                    Kept in lockstep with the `openai` row on purpose: the two
 *                    rows exist to compare the same model through OpenAI's own
 *                    web search and through OpenRouter's `:online` plugin, which
 *                    only means something if the model matches. Both ids were
 *                    confirmed present in https://openrouter.ai/api/v1/models.
 *
 *   perplexity       sonar-pro — unchanged, still current.
 *                    NOTE: Perplexity's docs carry "Sonar Chat Completions is
 *                    now Agent API. Sonar will be supported until September 27,
 *                    2026." This provider talks to /chat/completions, and the
 *                    Agent API is a different request shape — moving to it is a
 *                    provider rewrite, not a model-id change. Tracked separately.
 *
 *   exa              synthesisModel gpt-5.4-mini → gpt-5.6-luna
 *                    Same generation bump as the `openai` row, at the
 *                    cost-optimized tier, since synthesis is a summarization
 *                    step over retrieved text.
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
  { provider: "openai", model: "gpt-5.6-terra" },
  { provider: "anthropic", model: "claude-sonnet-5" },
  { provider: "anthropic-agent", model: "claude-sonnet-4-6" },
  { provider: "openrouter", model: "openai/gpt-5.6-terra:online" },
  { provider: "perplexity", model: "sonar-pro" },
  {
    provider: "exa",
    model: "exa-auto",
    options: { synthesisProvider: "openai", synthesisModel: "gpt-5.6-luna" },
  },
];

export function targetForProvider(provider: string): TargetEntry | undefined {
  return DEFAULT_TARGETS.find((t) => t.provider === provider);
}
