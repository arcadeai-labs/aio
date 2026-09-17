import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PerplexityProvider } from "../src/providers/perplexity.js";
import type { UnifiedResult } from "../src/types/unified-result.js";
import phase1AgentParsed from "./fixtures/perplexity-migration/agent-model-sonar-explicit-parsed.json";
import agentRaw from "./fixtures/perplexity-migration/agent-model-sonar-explicit-raw.json";
import baselineParsed from "./fixtures/perplexity-migration/baseline-parsed.json";
import baselineRaw from "./fixtures/perplexity-migration/baseline-raw.json";

/**
 * Acceptance criterion 3 of #16: "citations and search results are extracted as
 * before — compared against a **pre-migration run**, not merely 'present'".
 *
 * The pre-migration run is committed
 * (`fixtures/perplexity-migration/`, captured 2026-09-17), because the endpoint
 * it came from stops being served on 2026-09-27 and cannot be recaptured. So
 * this file needs **no credential and no network** and will keep working after
 * the old API is gone — which is the whole point. A parity check that only runs
 * when someone exports a live key is a parity check that runs once.
 *
 * What is under test is the **shipped provider**, not a stand-in. The real
 * `PerplexityProvider` runs against the captured wire response, replayed
 * through `fetch`. Only the transport is stubbed; every line of parsing,
 * validation and mapping is the code that runs in production.
 */

const PERPLEXITY_SENTINEL = "sentinel-perplexity-key-not-real";
const KEY_VAR: string = "PERPLEXITY_API_KEY";

interface Capture {
  status: number;
  url: string;
  requestBody: unknown;
  responseBody: unknown;
}

const baseline = baselineParsed as unknown as UnifiedResult;
const agentCapture = agentRaw as unknown as Capture;
const baselineCapture = baselineRaw as unknown as Capture;

const realFetch = globalThis.fetch;
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env[KEY_VAR];
  process.env[KEY_VAR] = PERPLEXITY_SENTINEL;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  // Computed access, not `process.env.PERPLEXITY_API_KEY`: assigning
  // `undefined` to an env var stores the *string* "undefined", which would look
  // like a configured key to `requireApiKey`.
  if (savedKey === undefined) delete process.env[KEY_VAR];
  else process.env[KEY_VAR] = savedKey;
});

/** Replay a captured response body for any request the provider makes. */
function replay(body: unknown, status = 200): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    state.calls++;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return state;
}

async function runAgainstCapturedAgentResponse(): Promise<UnifiedResult> {
  replay(agentCapture.responseBody);
  return new PerplexityProvider().run({
    prompt: baseline.prompt,
    model: "perplexity/sonar",
    runId: "parity-test",
  });
}

describe("the committed fixtures are what they claim to be", () => {
  // Every assertion below reads from these files. If a future edit truncates or
  // replaces one, the parity tests would pass over an empty collection and
  // prove nothing — this project's house failure. Gate on the fixtures first.
  test("the baseline capture is a real HTTP 200 from the OLD endpoint", () => {
    expect(baselineCapture.status).toBe(200);
    expect(baselineCapture.url).toBe(
      "https://api.perplexity.ai/chat/completions",
    );
    expect(baselineCapture.requestBody).toEqual({
      model: "sonar-pro",
      messages: [
        { role: "user", content: "What is Taskwell and who is it for?" },
      ],
    });
  });

  test("the agent capture is a real HTTP 200 from the NEW endpoint, with the shape the provider sends", () => {
    expect(agentCapture.status).toBe(200);
    expect(agentCapture.url).toBe("https://api.perplexity.ai/v1/agent");
    // This is the request the shipped provider builds. If `execute()` ever
    // stops sending the web_search tool, this fixture stops describing it —
    // and an untooled request is the silent-zero failure this migration is
    // most exposed to.
    expect(agentCapture.requestBody).toEqual({
      model: "perplexity/sonar",
      input: "What is Taskwell and who is it for?",
      tools: [{ type: "web_search" }],
    });
  });

  test("the pre-migration baseline actually carried citations and search results", () => {
    // Without this, every "agent >= baseline" assertion below could be
    // satisfied by two zeros.
    expect(baseline.citations.length).toBeGreaterThan(0);
    expect(baseline.searchResults.length).toBeGreaterThan(0);
    expect(baseline.responseText.trim().length).toBeGreaterThan(0);
    expect(baseline.error).toBeNull();
    expect(baseline.metadata.model).toBe("sonar-pro");
  });
});

describe("why citations come from search_results and not annotations", () => {
  test("the old endpoint's citations[] was byte-identical to search_results[].url", () => {
    // The measurement that justifies the mapping. The old `citations` carried
    // no information the search results did not already have — same URLs, same
    // order — so sourcing the new ones from `search_results` is exact parity
    // rather than a downgrade.
    const body = baselineCapture.responseBody as {
      citations: string[];
      search_results: Array<{ url: string }>;
    };
    expect(body.citations.length).toBeGreaterThan(0);
    expect(body.citations).toEqual(body.search_results.map((r) => r.url));
  });

  test("annotations is empty on the captured Agent response, so mapping citations from it yields zero", () => {
    const body = agentCapture.responseBody as {
      output: Array<{
        type: string;
        content?: Array<{ annotations?: unknown[] }>;
      }>;
    };
    const contents = body.output
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? []);
    // Assert the collection is non-empty before asserting over it.
    expect(contents.length).toBeGreaterThan(0);
    for (const c of contents) {
      expect(c.annotations).toEqual([]);
    }
  });

  test("the phase-1 mapper, which used annotations, produced zero citations from this very response", () => {
    // Kept as a regression anchor: this is what the obvious-looking mapping
    // does to real data. If someone "tidies up" the provider back onto
    // annotations, the parity test below goes red — and this test explains why.
    const phase1 = phase1AgentParsed as unknown as UnifiedResult;
    expect(phase1.searchResults.length).toBeGreaterThan(0);
    expect(phase1.citations).toEqual([]);
  });
});

describe("parity: the shipped provider vs the pre-migration run", () => {
  test("citations survive the migration, with real URLs and titles", async () => {
    const agent = await runAgainstCapturedAgentResponse();

    expect(agent.error).toBeNull();
    expect(agent.citations.length).toBeGreaterThan(0);

    // Excerpts, not counts. A count can be satisfied by placeholder objects.
    for (const c of agent.citations) {
      expect(c.url).toStartWith("http");
      expect(c.title.trim()).not.toBe("");
    }
    expect(agent.citations[0].url).toBe("https://gettaskwell.com/support");
    expect(agent.citations[0].title).toBe("Support - Taskwell");
    expect(agent.citations[0].citedText).toContain("Taskwell");
  });

  test("citations mirror search results exactly, as they did before", async () => {
    const agent = await runAgainstCapturedAgentResponse();
    expect(agent.searchResults.length).toBeGreaterThan(0);
    expect(agent.citations.map((c) => c.url)).toEqual(
      agent.searchResults.map((s) => s.url),
    );
  });

  test("search results survive, with url, title and snippet populated", async () => {
    const agent = await runAgainstCapturedAgentResponse();

    expect(agent.searchResults.length).toBeGreaterThan(0);
    for (const s of agent.searchResults) {
      expect(s.url).toStartWith("http");
      expect(s.title.trim()).not.toBe("");
      expect(s.snippet.trim()).not.toBe("");
    }
    expect(agent.searchResults[0].title).toBe("Support - Taskwell");
    expect(agent.searchResults[0].snippet).toContain("Taskwell");
  });

  test("the answer text survives and mentions the brand", async () => {
    const agent = await runAgainstCapturedAgentResponse();
    expect(agent.responseText.trim().length).toBeGreaterThan(0);
    expect(agent.responseText).toContain("Taskwell");
    // Both sides are real answers to the same question. The old tier was
    // wordier (perplexity/sonar is the base tier; sonar-pro is gone), so this
    // asserts substance, not equality.
    expect(baseline.responseText).toContain("Taskwell");
  });

  test("citation offsets stay unset on both sides — parity, not regression", async () => {
    const agent = await runAgainstCapturedAgentResponse();
    expect(baseline.citations.length).toBeGreaterThan(0);
    expect(agent.citations.length).toBeGreaterThan(0);
    for (const c of baseline.citations) expect(c.startIndex).toBeUndefined();
    for (const c of agent.citations) expect(c.startIndex).toBeUndefined();
  });

  test("token usage survives the field rename", async () => {
    const agent = await runAgainstCapturedAgentResponse();
    expect(baseline.metadata.tokenUsage.inputTokens).toBeGreaterThan(0);
    expect(agent.metadata.tokenUsage.inputTokens).toBeGreaterThan(0);
    expect(agent.metadata.tokenUsage.outputTokens).toBeGreaterThan(0);
  });
});

describe("what the migration gains", () => {
  test("searchQueries is populated, where the old endpoint could never report it", async () => {
    const agent = await runAgainstCapturedAgentResponse();
    expect(baseline.searchQueries).toEqual([]);
    expect(agent.searchQueries.length).toBeGreaterThan(0);
    for (const q of agent.searchQueries) {
      expect(q.query.trim()).not.toBe("");
      expect(Number.isNaN(Date.parse(q.timestamp))).toBe(false);
    }
    expect(agent.searchQueries.map((q) => q.query)).toContain(
      "Taskwell what is it who is it for",
    );
  });

  test("searchRequests records the server's own count of searches performed", async () => {
    const agent = await runAgainstCapturedAgentResponse();
    expect(baseline.metadata.tokenUsage.searchRequests).toBeUndefined();
    expect(agent.metadata.tokenUsage.searchRequests).toBe(1);
  });

  test("estimatedCostUsd is now mapped — a pre-existing miss, not an Agent API gain", async () => {
    const agent = await runAgainstCapturedAgentResponse();
    // The OLD endpoint returned usage.cost.total_cost too; the old provider
    // simply never read it. Asserting both halves so the claim is checkable.
    const oldBody = baselineCapture.responseBody as {
      usage: { cost: { total_cost: number } };
    };
    expect(oldBody.usage.cost.total_cost).toBeGreaterThan(0);
    expect(baseline.metadata.estimatedCostUsd).toBeUndefined();
    expect(agent.metadata.estimatedCostUsd).toBeCloseTo(0.00397, 5);
  });

  test("pageDate is mapped where present and absent where not — never an empty string", async () => {
    const agent = await runAgainstCapturedAgentResponse();
    const dated = agent.searchResults.filter((s) => s.pageDate !== undefined);
    expect(dated.length).toBeGreaterThan(0);
    for (const s of dated) {
      expect(s.pageDate).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
    // Absence must stay absence. An empty string here would ingest as data.
    for (const s of agent.searchResults) {
      expect(s.pageDate).not.toBe("");
    }
  });

  test("rawSearchCalls carries the real queries, not a synthetic placeholder", async () => {
    const agent = await runAgainstCapturedAgentResponse();
    expect(agent.rawSearchCalls?.length).toBeGreaterThan(0);
    const call = agent.rawSearchCalls?.[0];
    expect(call?.queryText).toBe("Taskwell what is it who is it for");
    // The old path could only ever record `null` here.
    expect(baseline.rawSearchCalls?.[0]?.queryText).toBeNull();
  });
});

describe("the UnifiedResult contract does not move (criterion 4)", () => {
  const OPTIONAL_TOP = new Set([
    "promptCategory",
    "promptMeta",
    "rawSearchCalls",
  ]);
  const OPTIONAL_META = new Set(["estimatedCostUsd", "providerMeta"]);

  const required = (o: object, optional: Set<string>) =>
    Object.keys(o)
      .filter((k) => !optional.has(k))
      .sort();

  test("required keys are identical before and after, top level and in metadata", async () => {
    const agent = await runAgainstCapturedAgentResponse();
    expect(required(agent, OPTIONAL_TOP)).toEqual(
      required(baseline, OPTIONAL_TOP),
    );
    expect(required(agent.metadata, OPTIONAL_META)).toEqual(
      required(baseline.metadata, OPTIONAL_META),
    );
    // Guard the guard: if the key list were empty the comparison above is
    // vacuously true.
    expect(required(agent, OPTIONAL_TOP).length).toBeGreaterThan(5);
  });

  test("the provider records the new searchTool and the model it was asked for", async () => {
    const agent = await runAgainstCapturedAgentResponse();
    expect(agent.metadata.searchTool).toBe("perplexity-agent");
    expect(agent.metadata.model).toBe("perplexity/sonar");
    expect(agent.metadata.provider).toBe("perplexity");
    // The week-over-week join reads metadata.model. The series legitimately
    // changes; this pins that it changes to the id we decided on and not to
    // whatever the server happened to echo.
    expect(baseline.metadata.model).toBe("sonar-pro");
  });
});
