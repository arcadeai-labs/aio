import { describe, expect, test } from "bun:test";
import {
  type AgentResponse,
  mapAgentResponseToUnified,
} from "../src/perplexity-migration/agent-response.js";
import {
  compareResults,
  compareShape,
} from "../src/perplexity-migration/compare.js";
import type { UnifiedResult } from "../src/types/unified-result.js";

/**
 * Tests for the #16 validation harness, which has no key and cannot make a
 * call. What is checkable without one is exactly two things, and they are the
 * two that decide whether the harness is worth handing a credential:
 *
 *   1. The candidate Agent API → `UnifiedResult` mapping produces the contract's
 *      shape and nothing else (acceptance criterion 4, checked mechanically).
 *   2. The comparator scores a dropped-citations response as a FAILURE and does
 *      not score two empties as a pass. If it got that backwards, the harness
 *      would certify the exact bug it exists to catch.
 *
 * The fixtures below are hand-built from the documented response shapes (read
 * 2026-09-17), not from a real call. They are here to test the harness, not to
 * stand in for the baseline — a baseline made of invented JSON would be worse
 * than none, because it looks like evidence.
 */

const MAP_INPUT = {
  prompt: "What is Taskwell and who is it for?",
  model: "low",
  runId: "test-run",
};

/** An Agent API response with everything the mapping table claims it carries. */
const FULL_AGENT_RESPONSE: AgentResponse = {
  id: "resp_1",
  object: "response",
  created_at: 1_789_000_000,
  status: "completed",
  model: "openai/gpt-5.6-luna",
  output: [
    {
      type: "search_results",
      queries: ["Taskwell to-do app", "Taskwell review"],
      results: [
        {
          id: "sr_1",
          url: "https://taskwell.example/about",
          title: "About Taskwell",
          snippet: "Taskwell is a to-do app for small teams.",
          date: "2026-04-01",
          last_updated: "2026-09-01",
          source: "web",
        },
        {
          id: "sr_2",
          url: "https://review.example/taskwell",
          title: "Taskwell reviewed",
          snippet: "We used Taskwell for a month.",
        },
      ],
    },
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Taskwell is a to-do app [1] aimed at small teams [2].",
          annotations: [
            {
              type: "url_citation",
              url: "https://taskwell.example/about",
              title: "About Taskwell",
              start_index: 0,
              end_index: 25,
            },
            {
              type: "url_citation",
              url: "https://review.example/taskwell",
              title: "Taskwell reviewed",
              start_index: 26,
              end_index: 51,
            },
          ],
        },
      ],
    },
  ],
  usage: {
    input_tokens: 120,
    output_tokens: 240,
    total_tokens: 360,
    cost: { total_cost: 0.0042, currency: "USD" },
  },
  error: null,
};

/**
 * The failure this project actually ships: a fluent answer with the search step
 * missing. No error, no crash, plausible text, zero citations.
 */
const SILENT_ZERO_RESPONSE: AgentResponse = {
  id: "resp_2",
  object: "response",
  created_at: 1_789_000_000,
  status: "completed",
  model: "openai/gpt-5.6-luna",
  output: [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "Taskwell is a to-do app aimed at small teams.",
        },
      ],
    },
  ],
  usage: { input_tokens: 120, output_tokens: 240 },
  error: null,
};

/** A `UnifiedResult` shaped like one the current chat-completions path emits. */
function baselineResult(overrides: Partial<UnifiedResult> = {}): UnifiedResult {
  return {
    id: "baseline-1",
    prompt: MAP_INPUT.prompt,
    searchQueries: [],
    searchResults: [
      {
        url: "https://taskwell.example/about",
        title: "About Taskwell",
        snippet: "Taskwell is a to-do app for small teams.",
      },
    ],
    responseText: "Taskwell is a to-do app [1].",
    citations: [
      {
        url: "https://taskwell.example/about",
        title: "About Taskwell",
        citedText: "Taskwell is a to-do app for small teams.",
      },
    ],
    rawSearchCalls: [
      {
        callIndex: 0,
        timestamp: "2026-09-17T00:00:00.000Z",
        queryText: null,
        rawInput: null,
        rawOutput: {},
      },
    ],
    metadata: {
      provider: "perplexity",
      model: "sonar-pro",
      searchTool: "perplexity-sonar",
      startedAt: "2026-09-17T00:00:00.000Z",
      completedAt: "2026-09-17T00:00:01.000Z",
      latencyMs: 1000,
      tokenUsage: { inputTokens: 100, outputTokens: 200 },
      runId: "test-run",
    },
    error: null,
    ...overrides,
  };
}

describe("mapAgentResponseToUnified", () => {
  test("extracts the answer from the message output item", () => {
    const r = mapAgentResponseToUnified(FULL_AGENT_RESPONSE, MAP_INPUT);
    expect(r.responseText).toBe(
      "Taskwell is a to-do app [1] aimed at small teams [2].",
    );
  });

  test("extracts search results from the search_results output item", () => {
    const r = mapAgentResponseToUnified(FULL_AGENT_RESPONSE, MAP_INPUT);
    expect(r.searchResults).toHaveLength(2);
    expect(r.searchResults[0]).toEqual({
      url: "https://taskwell.example/about",
      title: "About Taskwell",
      snippet: "Taskwell is a to-do app for small teams.",
      pageDate: "2026-04-01",
    });
    // A result with no date must not invent one.
    expect(r.searchResults[1].pageDate).toBeUndefined();
  });

  test("extracts citations from annotations, with the offsets the old shape never had", () => {
    const r = mapAgentResponseToUnified(FULL_AGENT_RESPONSE, MAP_INPUT);
    expect(r.citations).toHaveLength(2);
    expect(r.citations[0]).toEqual({
      url: "https://taskwell.example/about",
      title: "About Taskwell",
      // Neither response shape ships the cited span's text; both borrow the
      // matching search result's snippet.
      citedText: "Taskwell is a to-do app for small teams.",
      startIndex: 0,
      endIndex: 25,
    });
  });

  test("populates searchQueries, which chat-completions never could", () => {
    const r = mapAgentResponseToUnified(FULL_AGENT_RESPONSE, MAP_INPUT);
    expect(r.searchQueries.map((q) => q.query)).toEqual([
      "Taskwell to-do app",
      "Taskwell review",
    ]);
  });

  test("maps input_tokens/output_tokens and the cost breakdown", () => {
    const r = mapAgentResponseToUnified(FULL_AGENT_RESPONSE, MAP_INPUT);
    expect(r.metadata.tokenUsage.inputTokens).toBe(120);
    expect(r.metadata.tokenUsage.outputTokens).toBe(240);
    expect(r.metadata.estimatedCostUsd).toBe(0.0042);
  });

  test("records the model id the caller chose, not the one the server reports", () => {
    // This is the week-over-week join key. If a preset silently re-points at a
    // different model, `metadata.model` still reads "low" — which is the whole
    // reason the preset choice is a decision and not a detail.
    const r = mapAgentResponseToUnified(FULL_AGENT_RESPONSE, MAP_INPUT);
    expect(r.metadata.model).toBe("low");
    expect(FULL_AGENT_RESPONSE.model).toBe("openai/gpt-5.6-luna");
  });

  test("a response with no search step maps to zero citations, not a throw", () => {
    const r = mapAgentResponseToUnified(SILENT_ZERO_RESPONSE, MAP_INPUT);
    expect(r.responseText).not.toBe("");
    expect(r.citations).toEqual([]);
    expect(r.searchResults).toEqual([]);
    expect(r.error).toBeNull();
  });

  test("an empty response maps to an empty result rather than throwing", () => {
    const r = mapAgentResponseToUnified({}, MAP_INPUT);
    expect(r.responseText).toBe("");
    expect(r.citations).toEqual([]);
    expect(r.searchResults).toEqual([]);
    expect(r.searchQueries).toEqual([]);
  });
});

describe("compareShape — acceptance criterion 4, checked mechanically", () => {
  test("the mapped Agent result has the same required keys as a chat-completions result", () => {
    const agent = mapAgentResponseToUnified(FULL_AGENT_RESPONSE, MAP_INPUT);
    expect(compareShape(baselineResult(), agent)).toEqual([]);
  });

  test("a stray extra field is reported, not ignored", () => {
    const agent = mapAgentResponseToUnified(FULL_AGENT_RESPONSE, MAP_INPUT);
    const mutated = { ...agent, sourcesRaw: [] } as unknown as UnifiedResult;
    expect(compareShape(baselineResult(), mutated)).toEqual([
      "extra on agent: sourcesRaw",
    ]);
  });
});

describe("compareResults", () => {
  test("a full Agent response passes every gated field", () => {
    const agent = mapAgentResponseToUnified(FULL_AGENT_RESPONSE, MAP_INPUT);
    const report = compareResults(baselineResult(), agent);
    const failed = report.fields.filter((f) => !f.passed);
    expect(failed.map((f) => f.field)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  test("searchQueries scores as a gain, not a regression", () => {
    const agent = mapAgentResponseToUnified(FULL_AGENT_RESPONSE, MAP_INPUT);
    const q = compareResults(baselineResult(), agent).fields.find(
      (f) => f.field === "searchQueries",
    );
    expect(q?.verdict).toBe("gain");
    expect(q?.passed).toBe(true);
  });

  test("dropped citations FAIL — the silent zero this whole exercise is about", () => {
    const agent = mapAgentResponseToUnified(SILENT_ZERO_RESPONSE, MAP_INPUT);
    const report = compareResults(baselineResult(), agent);
    expect(report.passed).toBe(false);

    const citations = report.fields.find((f) => f.field === "citations");
    expect(citations?.verdict).toBe("regression");
    expect(citations?.passed).toBe(false);

    const results = report.fields.find((f) => f.field === "searchResults");
    expect(results?.verdict).toBe("regression");
    expect(results?.passed).toBe(false);

    // And the answer text is fine, which is exactly why this would otherwise
    // reach the dashboard as a believable number.
    expect(report.fields.find((f) => f.field === "responseText")?.passed).toBe(
      true,
    );
  });

  test("both sides empty FAILS a gated field — two zeros are not evidence", () => {
    const agent = mapAgentResponseToUnified(SILENT_ZERO_RESPONSE, MAP_INPUT);
    // A baseline that itself found nothing. Deep-equality would call this a
    // match; the whole point is that it is not one.
    const emptyBaseline = baselineResult({ searchResults: [], citations: [] });
    const report = compareResults(emptyBaseline, agent);

    const citations = report.fields.find((f) => f.field === "citations");
    expect(citations?.verdict).toBe("unprovable");
    expect(citations?.passed).toBe(false);
    expect(report.passed).toBe(false);
  });

  test("an errored baseline fails rather than comparing against nothing", () => {
    const agent = mapAgentResponseToUnified(FULL_AGENT_RESPONSE, MAP_INPUT);
    const errored = baselineResult({
      error: {
        code: "HTTP_401",
        message: "unauthorized",
        retryable: false,
        retriesAttempted: 2,
      },
    });
    const report = compareResults(errored, agent);
    expect(report.fields.find((f) => f.field === "error")?.passed).toBe(false);
    expect(report.passed).toBe(false);
  });
});
