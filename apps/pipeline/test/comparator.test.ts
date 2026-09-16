import { describe, expect, test } from "bun:test";
import type { ResultVerdict } from "@aio/core";
import { compareWeeks } from "../src/analytics/comparator.js";

function verdict(overrides: Partial<ResultVerdict> = {}): ResultVerdict {
  return {
    resultId: "r",
    prompt: "Q",
    provider: "openai",
    model: "gpt-5.2",
    promptCategory: null,
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
    analyzedAt: "2026-06-15T00:00:00Z",
    judgeModel: "gpt-5.2",
    judgeTokens: { input: 0, output: 0 },
    ...overrides,
  };
}

describe("compareWeeks deltas", () => {
  test("flags a newly gained mention", () => {
    const prev = [
      verdict({
        brandMention: { mentioned: false, mentionCount: 0, excerpts: [] },
      }),
    ];
    const curr = [
      verdict({
        brandMention: {
          mentioned: true,
          mentionCount: 1,
          excerpts: ["Taskwell"],
        },
      }),
    ];
    const { deltas } = compareWeeks(curr, prev, "2026-06-15", "2026-06-08");
    expect(deltas).toHaveLength(1);
    expect(deltas[0].newMention).toBe(true);
    expect(deltas[0].lostMention).toBe(false);
  });

  test("flags a lost mention", () => {
    const prev = [
      verdict({
        brandMention: { mentioned: true, mentionCount: 1, excerpts: [] },
      }),
    ];
    const curr = [
      verdict({
        brandMention: { mentioned: false, mentionCount: 0, excerpts: [] },
      }),
    ];
    const { deltas } = compareWeeks(curr, prev, "2026-06-15", "2026-06-08");
    expect(deltas[0].lostMention).toBe(true);
    expect(deltas[0].newMention).toBe(false);
  });

  test("computes accuracyDelta only when both weeks have a score", () => {
    const prev = [
      verdict({ descriptionAccuracy: { score: 3, reasoning: "" } }),
    ];
    const curr = [
      verdict({ descriptionAccuracy: { score: 5, reasoning: "" } }),
    ];
    expect(compareWeeks(curr, prev, "a", "b").deltas[0].accuracyDelta).toBe(2);

    const currNull = [verdict({ descriptionAccuracy: null })];
    expect(
      compareWeeks(currNull, prev, "a", "b").deltas[0].accuracyDelta,
    ).toBeNull();
  });

  test("rankImproved is true when rank moves to a better (lower) position", () => {
    const prev = [
      verdict({
        competitivePosition: {
          othersPresent: true,
          othersCount: 2,
          brandRank: "not_ranked",
          competitors: [],
        },
      }),
    ];
    const curr = [
      verdict({
        competitivePosition: {
          othersPresent: true,
          othersCount: 2,
          brandRank: 1,
          competitors: [],
        },
      }),
    ];
    expect(compareWeeks(curr, prev, "a", "b").deltas[0].rankImproved).toBe(
      true,
    );

    // not_ranked maps to 4 (worst), so not_ranked -> 3 still counts as improved.
    // A genuine non-improvement: prev was already 1st, curr slips to 3rd.
    const prevTop = [
      verdict({
        competitivePosition: {
          othersPresent: true,
          othersCount: 2,
          brandRank: 1,
          competitors: [],
        },
      }),
    ];
    const slipped = [
      verdict({
        competitivePosition: {
          othersPresent: true,
          othersCount: 2,
          brandRank: 3,
          competitors: [],
        },
      }),
    ];
    expect(
      compareWeeks(slipped, prevTop, "a", "b").deltas[0].rankImproved,
    ).toBe(false);
  });

  test("tracks new and departed competitors, counting only mentioned ones", () => {
    const prev = [
      verdict({
        competitivePosition: {
          othersPresent: true,
          othersCount: 1,
          brandRank: "not_ranked",
          competitors: [
            { name: "Todoist", mentioned: true, citedUrls: [] },
            { name: "Any.do", mentioned: false, citedUrls: [] },
          ],
        },
      }),
    ];
    const curr = [
      verdict({
        competitivePosition: {
          othersPresent: true,
          othersCount: 1,
          brandRank: "not_ranked",
          competitors: [{ name: "Asana", mentioned: true, citedUrls: [] }],
        },
      }),
    ];
    const d = compareWeeks(curr, prev, "a", "b").deltas[0];
    expect(d.newCompetitors).toEqual(["Asana"]);
    expect(d.departedCompetitors).toEqual(["Todoist"]); // Any.do was not mentioned, so not counted
  });

  test("skips current results that have no matching previous result", () => {
    const prev = [verdict({ prompt: "Q1" })];
    const curr = [verdict({ prompt: "Q1" }), verdict({ prompt: "Q2-new" })];
    const { deltas } = compareWeeks(curr, prev, "a", "b");
    expect(deltas.map((d) => d.prompt)).toEqual(["Q1"]);
  });

  test("matches on prompt+provider+model, not prompt alone", () => {
    const prev = [verdict({ prompt: "Q", provider: "openai" })];
    const curr = [verdict({ prompt: "Q", provider: "anthropic" })];
    expect(compareWeeks(curr, prev, "a", "b").deltas).toHaveLength(0);
  });
});

describe("compareWeeks summary", () => {
  test("aggregates mention, accuracy, citation, primary rank and competitor counts", () => {
    const prev = [
      verdict({
        prompt: "Q1",
        brandMention: { mentioned: true, mentionCount: 1, excerpts: [] },
        descriptionAccuracy: { score: 2, reasoning: "" },
        ownedCitation: { cited: true, urls: ["taskwell.app"] },
        competitivePosition: {
          othersPresent: true,
          othersCount: 1,
          brandRank: 1,
          competitors: [{ name: "Todoist", mentioned: true, citedUrls: [] }],
        },
      }),
      verdict({
        prompt: "Q2",
        brandMention: { mentioned: false, mentionCount: 0, excerpts: [] },
      }),
    ];
    const curr = [
      verdict({
        prompt: "Q1",
        brandMention: { mentioned: true, mentionCount: 2, excerpts: [] },
        descriptionAccuracy: { score: 4, reasoning: "" },
        ownedCitation: { cited: true, urls: ["taskwell.app"] },
        competitivePosition: {
          othersPresent: true,
          othersCount: 1,
          brandRank: 1,
          competitors: [{ name: "Todoist", mentioned: true, citedUrls: [] }],
        },
      }),
      verdict({
        prompt: "Q2",
        brandMention: { mentioned: true, mentionCount: 1, excerpts: [] },
        descriptionAccuracy: { score: 4, reasoning: "" },
      }),
    ];
    const { summary } = compareWeeks(curr, prev, "2026-06-15", "2026-06-08");

    expect(summary.totalResults).toBe(2);
    expect(summary.mentionedCount).toEqual({ prev: 1, curr: 2 });
    expect(summary.avgAccuracy.prev).toBe(2);
    expect(summary.avgAccuracy.curr).toBe(4); // (4+4)/2
    expect(summary.ownedCitationCount).toEqual({ prev: 1, curr: 1 });
    expect(summary.primaryRankCount).toEqual({ prev: 1, curr: 1 });
    expect(summary.competitorCounts.Todoist).toEqual({ prev: 1, curr: 1 });
  });

  test("avgAccuracy is null when no results carry a score", () => {
    const { summary } = compareWeeks([verdict()], [verdict()], "a", "b");
    expect(summary.avgAccuracy).toEqual({ prev: null, curr: null });
  });
});
