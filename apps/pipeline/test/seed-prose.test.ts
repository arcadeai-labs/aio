// Property tests for what the corpus *says*.
//
// #2's placeholder generator drew sentences independently of the verdict they
// sat on, and independent browser verification of its output measured the
// result: 490 response sentences from 42 templates, one response carrying the
// same sentence twice, the predicate "is the more opinionated choice" pasted
// onto three different products in one paragraph, and — the one that matters —
// an excerpt reading "Taskwell is the option reviewers reach for first" on a
// result whose own verdict recorded `brandRank: 3`.
//
// Over two flat weeks that last one is cosmetic. Over fifteen weeks containing a
// competitor overtake it is fatal: the excerpts surface directly in the UI, so a
// reader opening the competitive view to understand the crossover would find the
// prose insisting the opposite of the chart beside it.
//
// The three properties below are the fix, in ascending order of importance:
//   1. no sentence repeats within a response;
//   2. no two products share a predicate within a response;
//   3. every excerpt is drawn from the pool keyed by its own result's rank and
//      accuracy — prose is a function of verdict state, never a parallel draw.
//
// None of them asserts a generated string. They assert that whatever was
// generated stands in the right relation to the verdict it came from.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ResultVerdict, UnifiedResult } from "@aio/core";
import { loadAnalyticsConfig } from "../src/analytics/config.js";
import { loadPrompts } from "../src/load.js";
import {
  BRAND_ABSENT,
  BRAND_DESCRIPTION,
  BRAND_POSITION,
  RISER_ASCENDANT,
  type RankTier,
} from "../src/seed/prose.js";
import { createRng } from "../src/seed/rng.js";
import { type WorldSpec, buildCorpus } from "../src/seed/scenario.js";
import { type AccuracyTier, accuracyTier } from "../src/seed/world.js";
import { DEFAULT_TARGETS } from "../src/targets.js";

const ROOT = resolve(import.meta.dir, "../../..");
const WEEKS = 15;

const config = await loadAnalyticsConfig(
  resolve(ROOT, "analytics.config.example.json"),
);
const prompts = await loadPrompts(resolve(ROOT, "prompts/default.csv"));

const SPEC: WorldSpec = {
  brand: config.brand,
  prompts,
  targets: DEFAULT_TARGETS,
  anchorDate: "2026-09-14",
  weeks: WEEKS,
  judgeModel: config.judgeModel,
};

const corpus = buildCorpus(SPEC, createRng("aio-tracer"));
const BRAND = config.brand.name;
const COMPETITORS = config.brand.knownCompetitors;

/** Every product a sentence can be about, longest first so no name is a prefix of another. */
const SUBJECTS = [BRAND, ...COMPETITORS].sort((a, b) => b.length - a.length);

/**
 * Recover the template a sentence was rendered from by putting the subject
 * placeholder back. Two products can only collide on a predicate by sharing a
 * template, so comparing templates is exactly the "no shared predicate" test.
 */
function templateOf(sentence: string): string {
  return SUBJECTS.reduce((acc, name) => acc.split(name).join("{x}"), sentence);
}

/**
 * Split on sentence-ending punctuation followed by whitespace. Deliberately not
 * the generator's own splitter — a test that reused it would agree with a bug.
 * (`Any.do` survives: its period is not followed by a space.)
 */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface Row {
  result: UnifiedResult;
  verdict: ResultVerdict;
  week: number;
}

const rows: Row[] = corpus.runs.flatMap((run, week) => {
  const byId = new Map(run.results.map((r) => [r.id, r]));
  return run.verdicts.flatMap((verdict) => {
    const result = byId.get(verdict.resultId);
    return result && result.error === null ? [{ result, verdict, week }] : [];
  });
});

function rankTierOf(verdict: ResultVerdict): RankTier {
  if (!verdict.competitivePosition.othersPresent) return "solo";
  const rank = verdict.competitivePosition.brandRank;
  return rank === 1
    ? "leader"
    : rank === 2
      ? "contender"
      : rank === 3
        ? "trailing"
        : "solo";
}

const POSITION_TIERS = Object.keys(BRAND_POSITION) as RankTier[];
const ACCURACY_TIERS = Object.keys(BRAND_DESCRIPTION) as AccuracyTier[];

// ── The pools themselves ────────────────────────────────────────────────────

describe("the phrasebook", () => {
  test("no template appears in two different pools", () => {
    // Everything below depends on a template naming exactly one state. If two
    // tiers shared a sentence, "this excerpt belongs to the leader pool" would
    // stop meaning anything and the coupling tests would pass vacuously.
    const seen = new Map<string, string>();
    const pools: [string, readonly string[]][] = [
      ...POSITION_TIERS.map(
        (t) =>
          [`position:${t}`, BRAND_POSITION[t]] as [string, readonly string[]],
      ),
      ...ACCURACY_TIERS.map(
        (t) =>
          [`description:${t}`, BRAND_DESCRIPTION[t]] as [
            string,
            readonly string[],
          ],
      ),
      ["riser", RISER_ASCENDANT],
      ["absent:branded", BRAND_ABSENT.branded],
      ["absent:unbranded", BRAND_ABSENT.unbranded],
    ];
    for (const [label, pool] of pools) {
      for (const template of pool) {
        expect({ template, owner: seen.get(template) ?? label }).toEqual({
          template,
          owner: label,
        });
        seen.set(template, label);
      }
    }
  });

  test("every brand template is reachable — no tier the corpus can never say", () => {
    // A pool that is never drawn is a state the prose cannot express. That is
    // how an excerpt ends up borrowed from the wrong tier.
    const used = new Set(
      rows.flatMap((r) => r.verdict.brandMention.excerpts.map(templateOf)),
    );
    for (const tier of POSITION_TIERS) {
      for (const template of BRAND_POSITION[tier]) {
        expect({ tier, template, used: used.has(template) }).toEqual({
          tier,
          template,
          used: true,
        });
      }
    }
    for (const tier of ACCURACY_TIERS) {
      for (const template of BRAND_DESCRIPTION[tier]) {
        expect({ tier, template, used: used.has(template) }).toEqual({
          tier,
          template,
          used: true,
        });
      }
    }
  });
});

// ── 1 & 2. Hygiene ──────────────────────────────────────────────────────────

describe("a response never repeats itself", () => {
  test("no sentence appears twice in one responseText", () => {
    for (const { result } of rows) {
      const sentences = sentencesOf(result.responseText);
      expect({
        id: result.id,
        duplicates: sentences.length - new Set(sentences).size,
      }).toEqual({ id: result.id, duplicates: 0 });
    }
  });

  test("no two products share a predicate within one response", () => {
    for (const { result } of rows) {
      const templates = sentencesOf(result.responseText).map(templateOf);
      expect({
        id: result.id,
        shared: templates.length - new Set(templates).size,
      }).toEqual({ id: result.id, shared: 0 });
    }
  });

  test("no two citations on one result quote the same string", () => {
    for (const { result } of rows) {
      const quoted = result.citations.map((c) => c.citedText).filter(Boolean);
      expect({
        id: result.id,
        duplicates: quoted.length - new Set(quoted).size,
      }).toEqual({ id: result.id, duplicates: 0 });
    }
  });

  test("a citation that quotes its source never echoes the answer's own prose", () => {
    // Scoped to the citations that quote a *source*. The pair that carry
    // `startIndex`/`endIndex` quote the **answer** by definition — that is what
    // an offset into `responseText` means, and both `providers/openai.ts` and
    // `providers/openrouter.ts` set `citedText = responseText.slice(...)`. The
    // rule this guards is the #2 defect: a source snippet that was really the
    // answer's own sentence pasted back as evidence.
    for (const { result } of rows) {
      const body = new Set(sentencesOf(result.responseText));
      for (const citation of result.citations) {
        if (citation.startIndex !== undefined) continue;
        expect({ id: result.id, echoed: body.has(citation.citedText) }).toEqual(
          {
            id: result.id,
            echoed: false,
          },
        );
      }
    }
  });

  test("a citation that carries offsets quotes exactly what they point at", () => {
    // The mirror of the rule above, and the one an offset is worthless
    // without: `startIndex`/`endIndex` are only meaningful if they resolve.
    let checked = 0;
    for (const { result } of rows) {
      for (const citation of result.citations) {
        if (citation.startIndex === undefined) continue;
        expect({
          id: result.id,
          resolved: result.responseText.slice(
            citation.startIndex,
            citation.endIndex,
          ),
        }).toEqual({ id: result.id, resolved: citation.citedText });
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// ── 3. The one that matters: prose follows the verdict ──────────────────────

describe("excerpts cannot contradict their own verdict", () => {
  test("every excerpt is a verbatim slice of the response it came from", () => {
    let checked = 0;
    for (const { result, verdict } of rows) {
      for (const excerpt of verdict.brandMention.excerpts) {
        expect(result.responseText).toContain(excerpt);
        expect(excerpt).toContain(BRAND);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test("an excerpt's sentiment matches the rank the same verdict recorded", () => {
    // The #2 failure, pinned: a "reviewers reach for it first" excerpt on a
    // brandRank of 3 is unreachable, because that sentence lives only in the
    // leader pool and a rank-3 result can only draw from `trailing`.
    for (const { verdict } of rows) {
      const tier = rankTierOf(verdict);
      for (const excerpt of verdict.brandMention.excerpts) {
        const template = templateOf(excerpt);
        const owner = POSITION_TIERS.find((t) =>
          BRAND_POSITION[t].includes(template),
        );
        if (!owner) continue; // a description sentence; checked below
        expect({ rank: verdict.competitivePosition.brandRank, owner }).toEqual({
          rank: verdict.competitivePosition.brandRank,
          owner: tier,
        });
      }
    }
  });

  test("an excerpt's precision matches the accuracy the same verdict scored", () => {
    // An excerpt on an early 2/5 result must not read like one on a late 5/5.
    for (const { verdict } of rows) {
      const score = verdict.descriptionAccuracy?.score;
      if (score === undefined) continue;
      const tier = accuracyTier(score);
      for (const excerpt of verdict.brandMention.excerpts) {
        const template = templateOf(excerpt);
        const owner = ACCURACY_TIERS.find((t) =>
          BRAND_DESCRIPTION[t].includes(template),
        );
        if (!owner) continue; // a position sentence; checked above
        expect({ score, owner }).toEqual({ score, owner: tier });
      }
    }
  });

  test("every excerpt comes from one of the two pools its verdict allows", () => {
    // Belt to the two braces above: an excerpt from no known pool would slip
    // past both `find` guards without failing either.
    for (const { verdict } of rows) {
      const rank = rankTierOf(verdict);
      const accuracy = accuracyTier(verdict.descriptionAccuracy?.score ?? 3);
      const allowed = new Set([
        ...BRAND_POSITION[rank],
        ...BRAND_DESCRIPTION[accuracy],
      ]);
      for (const excerpt of verdict.brandMention.excerpts) {
        const template = templateOf(excerpt);
        expect({ template, allowed: allowed.has(template) }).toEqual({
          template,
          allowed: true,
        });
      }
    }
  });

  test("mentionCount is the excerpt count, and an unmentioned brand has neither", () => {
    for (const { verdict } of rows) {
      expect(verdict.brandMention.mentionCount).toBe(
        verdict.brandMention.excerpts.length,
      );
      if (verdict.brandMention.mentioned) {
        expect(verdict.brandMention.excerpts.length).toBeGreaterThan(0);
      } else {
        expect(verdict.brandMention.excerpts).toEqual([]);
        expect(verdict.brandMention.mentionCount).toBe(0);
      }
    }
  });

  test("a response that did not mention the brand never names it", () => {
    for (const { result, verdict } of rows) {
      if (verdict.brandMention.mentioned) continue;
      expect(result.responseText).not.toContain(BRAND);
      expect(verdict.mentionHypothesis).not.toBeNull();
    }
  });
});

describe("the overtake is audible, not just plottable", () => {
  test("nothing calls the riser ascendant before it has passed us", () => {
    // The sentences that say a competitor has taken the lead are reserved for
    // the weeks in which it actually has. An excerpt panel that announced the
    // overtake in week one would contradict the chart as loudly as a stale
    // "reached for first" would.
    const ascendant = new Set(RISER_ASCENDANT);
    const weeksSpoken = new Set<number>();
    for (const { result, week } of rows) {
      for (const sentence of sentencesOf(result.responseText)) {
        if (ascendant.has(templateOf(sentence))) weeksSpoken.add(week);
      }
    }
    expect(weeksSpoken.size).toBeGreaterThan(0);
    expect(Math.min(...weeksSpoken)).toBeGreaterThan(WEEKS / 3);
    expect(Math.max(...weeksSpoken)).toBe(WEEKS - 1);
  });
});
