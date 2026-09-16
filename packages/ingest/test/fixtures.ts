// Tiny in-memory fixtures for ingest tests — small records over the real
// data contract, never the multi-hundred-MB files.

import type { ResultVerdict, UnifiedResult } from "@aio/core";

export function makeResult(
  over: Partial<UnifiedResult> & { id: string; prompt: string },
): UnifiedResult {
  return {
    promptCategory: "Alternatives & Vendor Comparison",
    promptMeta: {
      brandedType: "Unbranded",
      labels: "KEYWORDS_HIGH_IMPORTANCE",
    },
    searchQueries: [],
    searchResults: [],
    responseText: "an answer",
    citations: [],
    metadata: {
      provider: "openai",
      model: "gpt-5.2",
      searchTool: "web_search",
      startedAt: "2026-06-15T00:00:00.000Z",
      completedAt: "2026-06-15T00:00:01.000Z",
      latencyMs: 1000,
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      runId: "run-1",
    },
    error: null,
    ...over,
  };
}

export function makeVerdict(
  over: Partial<ResultVerdict> & { resultId: string; prompt: string },
): ResultVerdict {
  return {
    provider: "openai",
    model: "gpt-5.2",
    promptCategory: "Alternatives & Vendor Comparison",
    brandMention: { mentioned: false, mentionCount: 0, excerpts: [] },
    descriptionAccuracy: null,
    ownedCitation: { cited: false, urls: [] },
    competitivePosition: {
      othersPresent: false,
      othersCount: 0,
      brandRank: "not_ranked",
      competitors: [],
    },
    mentionHypothesis: null,
    analyzedAt: "2026-06-15T01:00:00.000Z",
    judgeModel: "gpt-5.2",
    judgeTokens: { input: 10, output: 5 },
    ...over,
  };
}
