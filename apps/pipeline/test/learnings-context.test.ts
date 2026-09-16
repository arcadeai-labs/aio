import { describe, expect, test } from "bun:test";
import type {
  ResultDelta,
  WeekComparison,
  WeekComparisonSummary,
} from "../src/analytics/types.js";
import { buildMoversContext } from "../src/learnings/context.js";

const SOURCE = "comparison-2026-06-22.json";

function delta(overrides: Partial<ResultDelta> = {}): ResultDelta {
  return {
    prompt: "Q",
    provider: "openai",
    model: "gpt-5.2",
    newMention: false,
    lostMention: false,
    prevAccuracy: null,
    currAccuracy: null,
    accuracyDelta: null,
    gainedOwnedCitation: false,
    lostOwnedCitation: false,
    prevRank: "not_ranked",
    currRank: "not_ranked",
    rankImproved: false,
    newCompetitors: [],
    departedCompetitors: [],
    mentionHypothesis: null,
    ...overrides,
  };
}

function summary(
  overrides: Partial<WeekComparisonSummary> = {},
): WeekComparisonSummary {
  return {
    totalResults: 0,
    mentionedCount: { prev: 0, curr: 0 },
    avgAccuracy: { prev: null, curr: null },
    ownedCitationCount: { prev: 0, curr: 0 },
    primaryRankCount: { prev: 0, curr: 0 },
    competitorCounts: {},
    ...overrides,
  };
}

function comparison(
  deltas: ResultDelta[],
  s: Partial<WeekComparisonSummary> = {},
): WeekComparison {
  return {
    currentDate: "2026-06-22",
    previousDate: "2026-06-15",
    deltas,
    summary: summary({ totalResults: deltas.length, ...s }),
  };
}

describe("buildMoversContext — headline metrics", () => {
  test("maps the four summary metrics with signed deltas", () => {
    const ctx = buildMoversContext(
      comparison([], {
        mentionedCount: { prev: 100, curr: 110 },
        avgAccuracy: { prev: 3.6, curr: 3.62 },
        ownedCitationCount: { prev: 50, curr: 45 },
        primaryRankCount: { prev: 10, curr: 10 },
      }),
      SOURCE,
    );

    const byMetric = Object.fromEntries(ctx.metrics.map((m) => [m.metric, m]));
    expect(byMetric.mentions).toMatchObject({
      prev: 100,
      curr: 110,
      delta: 10,
    });
    expect(byMetric.ownedCitations).toMatchObject({ delta: -5 });
    expect(byMetric.primaryRank).toMatchObject({ delta: 0 });
    expect(byMetric.avgAccuracy.delta).toBeCloseTo(0.02, 5);
  });

  test("avgAccuracy delta is null when either week lacks a score", () => {
    const ctx = buildMoversContext(
      comparison([], { avgAccuracy: { prev: null, curr: 3.6 } }),
      SOURCE,
    );
    const acc = ctx.metrics.find((m) => m.metric === "avgAccuracy");
    expect(acc?.delta).toBeNull();
  });

  test("carries through dates, total and source", () => {
    const ctx = buildMoversContext(comparison([delta()]), SOURCE);
    expect(ctx.currentDate).toBe("2026-06-22");
    expect(ctx.previousDate).toBe("2026-06-15");
    expect(ctx.totalResults).toBe(1);
    expect(ctx.source).toBe(SOURCE);
  });
});

describe("buildMoversContext — competitor moves", () => {
  test("splits gainers and losers, sorts by magnitude, drops no-move entries", () => {
    const ctx = buildMoversContext(
      comparison([], {
        competitorCounts: {
          Todoist: { prev: 800, curr: 826 }, // +26
          Notion: { prev: 300, curr: 343 }, // +43
          Asana: { prev: 350, curr: 335 }, // -15
          Merge: { prev: 309, curr: 309 }, // 0 — dropped
          TickTick: { prev: 341, curr: 314 }, // -27
        },
      }),
      SOURCE,
    );

    expect(ctx.topGainingCompetitors.map((c) => c.name)).toEqual([
      "Notion",
      "Todoist",
    ]);
    expect(ctx.topGainingCompetitors[0]).toMatchObject({ delta: 43 });
    expect(ctx.topLosingCompetitors.map((c) => c.name)).toEqual([
      "TickTick",
      "Asana",
    ]);
    // Merge (delta 0) appears in neither list.
    const allNames = [
      ...ctx.topGainingCompetitors,
      ...ctx.topLosingCompetitors,
    ].map((c) => c.name);
    expect(allNames).not.toContain("Merge");
  });

  test("caps each direction at five", () => {
    const counts: WeekComparisonSummary["competitorCounts"] = {};
    for (let i = 0; i < 8; i++) {
      counts[`Gainer${i}`] = { prev: 0, curr: i + 1 };
    }
    const ctx = buildMoversContext(
      comparison([], { competitorCounts: counts }),
      SOURCE,
    );
    expect(ctx.topGainingCompetitors).toHaveLength(5);
  });
});

describe("buildMoversContext — tallies", () => {
  test("counts signed per-result events", () => {
    const ctx = buildMoversContext(
      comparison([
        delta({ newMention: true }),
        delta({ newMention: true }),
        delta({ lostMention: true }),
        delta({ gainedOwnedCitation: true }),
        delta({ lostOwnedCitation: true }),
        delta({ rankImproved: true }),
        delta({ prevAccuracy: 3, currAccuracy: 5, accuracyDelta: 2 }),
        delta({ prevAccuracy: 4, currAccuracy: 2, accuracyDelta: -2 }),
        delta({ accuracyDelta: 0 }), // neither gain nor drop
      ]),
      SOURCE,
    );

    expect(ctx.tallies).toEqual({
      newMentions: 2,
      lostMentions: 1,
      gainedOwnedCitations: 1,
      lostOwnedCitations: 1,
      ranksImproved: 1,
      accuracyGains: 1,
      accuracyDrops: 1,
    });
  });
});

describe("buildMoversContext — notable examples", () => {
  test("caps each kind at two and total at eight, preserving delta order", () => {
    const deltas: ResultDelta[] = [
      delta({ prompt: "n1", newMention: true }),
      delta({ prompt: "n2", newMention: true }),
      delta({ prompt: "n3", newMention: true }), // 3rd newMention — excluded by per-kind cap
      delta({ prompt: "l1", lostMention: true }),
      delta({ prompt: "r1", rankImproved: true }),
    ];
    const ctx = buildMoversContext(comparison(deltas), SOURCE);

    const newMentionExamples = ctx.notableExamples.filter(
      (e) => e.kind === "newMention",
    );
    expect(newMentionExamples.map((e) => e.prompt)).toEqual(["n1", "n2"]);
    expect(ctx.notableExamples.some((e) => e.prompt === "n3")).toBe(false);
    expect(ctx.notableExamples.some((e) => e.kind === "lostMention")).toBe(
      true,
    );
    expect(ctx.notableExamples.some((e) => e.kind === "rankImproved")).toBe(
      true,
    );
  });

  test("classifies a delta by its highest-priority signal", () => {
    // newMention takes precedence over a co-occurring citation gain.
    const ctx = buildMoversContext(
      comparison([delta({ newMention: true, gainedOwnedCitation: true })]),
      SOURCE,
    );
    expect(ctx.notableExamples).toHaveLength(1);
    expect(ctx.notableExamples[0].kind).toBe("newMention");
  });

  test("produces no examples when nothing moved", () => {
    const ctx = buildMoversContext(comparison([delta(), delta()]), SOURCE);
    expect(ctx.notableExamples).toEqual([]);
  });
});
