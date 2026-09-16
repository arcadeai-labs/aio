import { describe, expect, test } from "bun:test";
import { promptId } from "../src/normalize.js";
import { buildRunBundle, dedupeVerdicts } from "../src/transform.js";
import { makeResult, makeVerdict } from "./fixtures.js";

const RUN = "2026-06-15";

describe("buildRunBundle — load-time hygiene", () => {
  test("dedupes analysis by resultId, keeping the latest analyzedAt", () => {
    const verdicts = [
      makeVerdict({
        resultId: "r1",
        prompt: "p",
        analyzedAt: "2026-06-15T01:00:00.000Z",
        mentionHypothesis: "stale",
      }),
      makeVerdict({
        resultId: "r1",
        prompt: "p",
        analyzedAt: "2026-06-17T09:00:00.000Z",
        mentionHypothesis: "fresh",
      }),
    ];
    const kept = dedupeVerdicts(verdicts);
    expect(kept).toHaveLength(1);
    expect(kept[0].mentionHypothesis).toBe("fresh");

    const bundle = buildRunBundle({
      runDate: RUN,
      results: [makeResult({ id: "r1", prompt: "p" })],
      verdicts,
    });
    expect(bundle.verdicts).toHaveLength(1);
    expect(bundle.verdicts[0].mentionHypothesis).toBe("fresh");
  });

  test("stores only mentioned=true competitors and their cited urls", () => {
    const bundle = buildRunBundle({
      runDate: RUN,
      results: [makeResult({ id: "r1", prompt: "p" })],
      verdicts: [
        makeVerdict({
          resultId: "r1",
          prompt: "p",
          competitivePosition: {
            othersPresent: true,
            othersCount: 1,
            brandRank: "not_ranked",
            competitors: [
              {
                name: "Todoist",
                mentioned: true,
                citedUrls: ["https://todoist.com"],
              },
              { name: "Notion", mentioned: false, citedUrls: [] },
              {
                name: "Merge",
                mentioned: false,
                citedUrls: ["https://merge.dev"],
              },
            ],
          },
        }),
      ],
    });
    expect(bundle.competitorMentions.map((c) => c.competitorName)).toEqual([
      "Todoist",
    ]);
    expect(bundle.competitorCitedUrls).toEqual([
      {
        resultId: "r1",
        competitorName: "Todoist",
        url: "https://todoist.com",
      },
    ]);
  });

  test("skips + flags verdicts whose resultId has no matching result", () => {
    const bundle = buildRunBundle({
      runDate: RUN,
      results: [makeResult({ id: "r1", prompt: "p" })],
      verdicts: [
        makeVerdict({ resultId: "r1", prompt: "p" }),
        makeVerdict({ resultId: "ghost", prompt: "p" }),
      ],
    });
    expect(bundle.verdicts.map((v) => v.resultId)).toEqual(["r1"]);
    expect(bundle.orphanVerdictIds).toEqual(["ghost"]);
  });

  test("derives has_error from the error field and carries error details", () => {
    const bundle = buildRunBundle({
      runDate: RUN,
      results: [
        makeResult({ id: "ok", prompt: "p" }),
        makeResult({
          id: "bad",
          prompt: "q",
          error: {
            code: "rate_limit",
            message: "429",
            retryable: true,
            retriesAttempted: 3,
          },
        }),
      ],
      verdicts: [],
    });
    const byId = Object.fromEntries(bundle.results.map((r) => [r.id, r]));
    expect(byId.ok.hasError).toBe(false);
    expect(byId.bad.hasError).toBe(true);
    expect(byId.bad.errorCode).toBe("rate_limit");
  });

  test("builds prompt dimension (theme/branded_type/labels) keyed by id", () => {
    const bundle = buildRunBundle({
      runDate: RUN,
      results: [
        makeResult({ id: "r1", prompt: "How does Taskwell work?" }),
        // same prompt, different provider → same prompt_id, one dimension row
        makeResult({
          id: "r2",
          prompt: "How does Taskwell work?",
          metadata: makeResult({ id: "x", prompt: "x" }).metadata,
        }),
      ],
      verdicts: [],
    });
    expect(bundle.prompts).toHaveLength(1);
    const p = bundle.prompts[0];
    expect(p.promptId).toBe(promptId("How does Taskwell work?"));
    expect(p.theme).toBe("Alternatives & Vendor Comparison");
    expect(p.brandedType).toBe("unbranded");
    expect(p.firstSeenRun).toBe(RUN);
    expect(p.lastSeenRun).toBe(RUN);
    expect(bundle.promptLabels).toEqual([
      { promptId: p.promptId, label: "KEYWORDS_HIGH_IMPORTANCE" },
    ]);
  });

  test("as-run theme/branded_type land on the result row", () => {
    const bundle = buildRunBundle({
      runDate: RUN,
      results: [
        makeResult({
          id: "r1",
          prompt: "p",
          promptCategory: "Agent Authorization",
          promptMeta: { brandedType: "Branded" },
        }),
      ],
      verdicts: [],
    });
    expect(bundle.results[0].runTheme).toBe("Agent Authorization");
    expect(bundle.results[0].runBrandedType).toBe("branded");
  });

  test("snapshots config relationally when provided", () => {
    const bundle = buildRunBundle({
      runDate: RUN,
      results: [makeResult({ id: "r1", prompt: "p" })],
      verdicts: [],
      config: {
        brand: {
          name: "Taskwell",
          aliases: ["Taskwell.app"],
          ownedDomains: ["taskwell.app", "docs.taskwell.app"],
          groundTruthDescription: "the action runtime",
          knownCompetitors: ["Todoist", "Notion"],
        },
        judgeModel: { provider: "openai", model: "gpt-5.2" },
        concurrency: 5,
        resultsDir: "results",
        outputDir: "results/analysis",
      },
    });
    expect(bundle.config?.brandName).toBe("Taskwell");
    expect(bundle.config?.ownedDomains).toEqual([
      "taskwell.app",
      "docs.taskwell.app",
    ]);
    expect(bundle.config?.competitors).toEqual(["Todoist", "Notion"]);
    expect(bundle.config?.aliases).toEqual(["Taskwell.app"]);
    expect(bundle.config?.judgeModel).toBe("gpt-5.2");
  });
});
