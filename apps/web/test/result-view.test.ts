import { describe, expect, test } from "bun:test";
import type { ResultDetail } from "@aio/db";
import {
  formatCost,
  formatLatency,
  formatTokens,
  hasText,
  hostOf,
  promptMetaFields,
  visibleCitations,
  visibleQueries,
  visibleSearchResults,
} from "../src/lib/result-view";

const detail = (over: Partial<ResultDetail> = {}): ResultDetail => ({
  resultId: "r",
  runDate: "2026-06-15",
  provider: "openai",
  model: "gpt-5.2",
  promptId: "p",
  promptText: "prompt",
  theme: "Pricing",
  brandedType: "branded",
  location: null,
  isRelevant: true,
  searchTool: null,
  latencyMs: null,
  inputTokens: null,
  outputTokens: null,
  estimatedCostUsd: null,
  responseText: "",
  hasError: false,
  errorMessage: null,
  citations: [],
  searchQueries: [],
  searchResults: [],
  verdict: null,
  ...over,
});

describe("hostOf", () => {
  test("strips scheme and www, keeps host", () => {
    expect(hostOf("https://www.taskwell.app/docs/x")).toBe("taskwell.app");
    expect(hostOf("https://dev.to/taskwell")).toBe("dev.to");
  });

  test("falls back to the raw string when not a parseable URL", () => {
    expect(hostOf("taskwell.app")).toBe("taskwell.app");
    expect(hostOf("")).toBe("");
  });
});

describe("formatLatency", () => {
  test("ms under a second, seconds above, null passthrough", () => {
    expect(formatLatency(842)).toBe("842ms");
    expect(formatLatency(2310)).toBe("2.31s");
    expect(formatLatency(null)).toBeNull();
  });
});

describe("formatTokens", () => {
  test("null only when both absent; one side renders em-dash", () => {
    expect(formatTokens(1024, 512)).toBe("1,024 in / 512 out");
    expect(formatTokens(1024, null)).toBe("1,024 in / — out");
    expect(formatTokens(null, null)).toBeNull();
  });
});

describe("formatCost", () => {
  test("four decimals, null passthrough", () => {
    expect(formatCost(0.01234)).toBe("$0.0123");
    expect(formatCost(null)).toBeNull();
  });
});

describe("hasText", () => {
  test("rejects null, undefined, empty, and whitespace-only", () => {
    expect(hasText("taskwell")).toBe(true);
    expect(hasText("  x  ")).toBe(true);
    expect(hasText("")).toBe(false);
    expect(hasText("   ")).toBe(false);
    expect(hasText(null)).toBe(false);
    expect(hasText(undefined)).toBe(false);
  });
});

describe("visibleCitations", () => {
  test("drops fully-blank placeholder rows, keeps rows with any content", () => {
    const cites = [
      { url: "", title: "", citedText: "" },
      { url: "https://taskwell.app", title: null, citedText: null },
      { url: "", title: "Taskwell", citedText: null },
      { url: "", title: null, citedText: "quoted passage" },
    ];
    expect(visibleCitations(cites).map((c) => c.title ?? c.url)).toEqual([
      "https://taskwell.app",
      "Taskwell",
      "",
    ]);
  });

  test("empty in, empty out (graceful empty state)", () => {
    expect(visibleCitations([])).toEqual([]);
  });
});

describe("visibleQueries", () => {
  test("drops blank/whitespace-only query rows", () => {
    const rows = [
      { query: "taskwell.app pricing" },
      { query: "" },
      { query: "   " },
      { query: "taskwell vs todoist" },
    ];
    expect(visibleQueries(rows).map((q) => q.query)).toEqual([
      "taskwell.app pricing",
      "taskwell vs todoist",
    ]);
  });

  test("empty in, empty out (graceful empty state)", () => {
    expect(visibleQueries([])).toEqual([]);
  });
});

describe("visibleSearchResults", () => {
  test("drops blank rows", () => {
    const rows = [
      { url: "", title: null, snippet: null },
      { url: "https://x.com", title: null, snippet: null },
    ];
    expect(visibleSearchResults(rows)).toEqual([
      { url: "https://x.com", title: null, snippet: null },
    ]);
  });
});

describe("promptMetaFields", () => {
  test("omits absent fields entirely (graceful sparse provider)", () => {
    expect(promptMetaFields(detail())).toEqual([]);
  });

  test("includes only the fields that have values, in order", () => {
    const fields = promptMetaFields(
      detail({
        location: "US",
        searchTool: "web_search",
        latencyMs: 1500,
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostUsd: 0.002,
      }),
    );
    expect(fields).toEqual([
      { label: "Location", value: "US" },
      { label: "Search tool", value: "web_search" },
      { label: "Latency", value: "1.50s" },
      { label: "Tokens", value: "100 in / 50 out" },
      { label: "Cost", value: "$0.0020" },
    ]);
  });

  test("surfaces non-relevant prompts, hides the relevant default", () => {
    expect(promptMetaFields(detail({ isRelevant: false }))).toEqual([
      { label: "Relevance", value: "Not relevant" },
    ]);
    expect(promptMetaFields(detail({ isRelevant: true }))).toEqual([]);
  });
});
