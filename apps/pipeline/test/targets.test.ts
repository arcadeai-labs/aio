import { describe, expect, test } from "bun:test";
import { getProvider, listProviders } from "../src/providers/registry.js";
import { DEFAULT_TARGETS, targetForProvider } from "../src/targets.js";

/**
 * The default matrix is what a forker's first `bun run start` touches, and the
 * only place provider options like Exa's synthesis model survive — a re-run
 * rebuilds the matrix from here, not from the result records. These tests pin
 * the shape so a later change has to be deliberate: widening the matrix, or
 * dropping an option a re-run needs, fails here rather than in a run nobody
 * is watching.
 */
describe("DEFAULT_TARGETS", () => {
  test("covers exactly the intended providers, one row each", () => {
    expect(DEFAULT_TARGETS.map((t) => t.provider)).toEqual([
      "openai",
      "anthropic",
      "anthropic-agent",
      "openrouter",
      "perplexity",
      "exa",
    ]);
  });

  test("every target names a provider the registry can construct", () => {
    const known = new Set(listProviders());
    for (const target of DEFAULT_TARGETS) {
      expect(known.has(target.provider)).toBe(true);
    }
  });

  test("every target pins a non-empty model id", () => {
    for (const target of DEFAULT_TARGETS) {
      expect(target.model.length).toBeGreaterThan(0);
      expect(target.model.trim()).toBe(target.model);
    }
  });

  test("targetForProvider recovers the full entry, options included", () => {
    // rerun-failed reconstructs a target from the provider name alone, so an
    // option that lives only here (and never on a result record) has to come
    // back with it or the re-run silently runs a different configuration.
    const exa = targetForProvider("exa");
    expect(exa).toBeDefined();
    expect(exa?.options).toEqual({
      synthesisProvider: "openai",
      synthesisModel: "gpt-5.6-luna",
    });
  });

  test("targetForProvider returns undefined for a provider outside the matrix", () => {
    expect(targetForProvider("codex")).toBeUndefined();
  });

  // `supportedModels` is a second source of truth for model validity, and
  // `healthCheck()` probes `supportedModels[0]`. When the matrix moves and the
  // list does not, the health check goes green against a model the pipeline no
  // longer runs — which is this project's house style of bug: a confident,
  // meaningless signal. Pin them together so drift fails here instead.
  test("each provider's healthCheck probes the model the matrix actually runs", () => {
    for (const target of DEFAULT_TARGETS) {
      const provider = getProvider(target.provider);
      expect({
        provider: target.provider,
        healthChecks: provider.supportedModels[0],
      }).toEqual({ provider: target.provider, healthChecks: target.model });
    }
  });

  // The Agent SDK drives a bundled Claude Code CLI that is versioned separately
  // from the Messages API and lags it, so these two rows legitimately differ.
  // Asserting the difference keeps a later "tidy-up" from syncing them and
  // re-breaking anthropic-agent, which is exactly how it went to 0/16.
  test("anthropic-agent is pinned independently of the anthropic API row", () => {
    const api = targetForProvider("anthropic");
    const agent = targetForProvider("anthropic-agent");
    expect(api?.model).toBe("claude-sonnet-5");
    expect(agent?.model).toBe("claude-sonnet-4-6");
    expect(getProvider("anthropic-agent").supportedModels).not.toContain(
      "claude-sonnet-5",
    );
  });
});
