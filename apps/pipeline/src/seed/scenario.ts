// The deep module of `bun run seed`: a world spec plus an RNG in, the complete
// corpus out. It renders records; `world.ts` decides what they should say and
// `prose.ts` decides how they say it. Splitting those out is what lets a single
// rule hold across the whole corpus — every sentence is drawn from a pool keyed
// by the verdict it sits on, so the excerpts in the UI can never contradict the
// charts beside them.
//
// PURITY CONTRACT (asserted by apps/pipeline/test/seed-scenario.test.ts):
// the import block below is the whole of this module's outside world. No
// `node:fs`, no `node:path`, no network client, no `Date.now()`, no
// `Math.random()`. Every value that varies comes from the injected `Rng`, and
// every date is derived from `spec.anchorDate`. A corpus that depended on the
// clock would not be reproducible, and reproducibility is the point.
import type {
  BrandConfig,
  BrandRank,
  Citation,
  CompetitorEntry,
  JudgeModelConfig,
  ResultVerdict,
  SearchQuery,
  SearchResult,
  UnifiedResult,
} from "@aio/core";
import type { PromptEntry, TargetEntry } from "../types/config.js";
import {
  ABSENCE_HYPOTHESES,
  ACCURACY_REASONS,
  COMPETITOR_PREDICATES,
  type CompetitorVoice,
  GENERIC_SOURCES,
  Phrasebook,
  QUERY_SUFFIXES,
  type RankTier,
  composeResponse,
} from "./prose.js";
import type { Rng } from "./rng.js";
import {
  type PromptKind,
  accuracyMean,
  accuracyTier,
  brandTopChance,
  competitorChance,
  mentionChance,
  outageTargetIndex,
  outageWeekIndex,
  ownedCitationChance,
  providerProfile,
  riserIndex,
  riserIsAhead,
  sampleAccuracy,
  seriesPosition,
} from "./world.js";

/** The world `buildCorpus` renders. Everything it needs, nothing it can read. */
export interface WorldSpec {
  /** Brand, aliases, owned domains and competitor cohort — from the analytics config. */
  brand: BrandConfig;
  /**
   * The prompt set, already loaded and filtered exactly as the real run loads it.
   * Prompt text is a join key: week-over-week matching is on
   * `(prompt, provider, model)`, so the same entries must be reused for every
   * week, byte for byte.
   */
  prompts: PromptEntry[];
  /** The provider/model matrix, as `DEFAULT_TARGETS` shapes it. */
  targets: TargetEntry[];
  /** `YYYY-MM-DD` of the most recent run. Earlier runs step back 7 days each. */
  anchorDate: string;
  /** How many runs to produce, most recent last. */
  weeks: number;
  /** Recorded on every verdict, so the corpus names the judge a real run would have used. */
  judgeModel: JudgeModelConfig;
}

/** One dated run: the results the pipeline would have written and the verdicts the judge would have. */
export interface SeededRun {
  runDate: string;
  runId: string;
  results: UnifiedResult[];
  verdicts: ResultVerdict[];
}

export interface SeededCorpus {
  runs: SeededRun[];
}

const RUN_START_HOUR_UTC = 9;
const SECONDS_BETWEEN_RESULTS = 7;
/** Verdicts are judged after the run that produced them, as in a real week. */
const ANALYSIS_HOUR_UTC = 18;

const DAY_MS = 86_400_000;

// ── Pure calendar arithmetic ────────────────────────────────────────────────
// `Date.UTC` and `new Date(millis)` are pure functions of their arguments. No
// clock is read; `Date.now()` appears nowhere in this file.

function shiftDays(isoDate: string, deltaDays: number): string {
  return new Date(utcMidnight(isoDate) + deltaDays * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function utcMidnight(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) {
    throw new Error(
      `WorldSpec.anchorDate must be YYYY-MM-DD, got "${isoDate}"`,
    );
  }
  return Date.UTC(y, m - 1, d);
}

function stampAt(isoDate: string, hourUtc: number, seconds: number): string {
  return new Date(
    utcMidnight(isoDate) + hourUtc * 3_600_000 + seconds * 1000,
  ).toISOString();
}

// ── Provider fidelity ───────────────────────────────────────────────────────

/**
 * What a provider records as `metadata.searchTool`. Mirrors the constants in
 * `src/providers/*.ts`; anything unlisted falls back to the provider name, as
 * `BaseProvider` does.
 */
const SEARCH_TOOLS: Record<string, string> = {
  openai: "web_search_preview",
  anthropic: "web_search_20250305",
  "anthropic-agent": "claude-agent-sdk-websearch",
  openrouter: "openrouter-online",
  perplexity: "perplexity-agent",
  exa: "exa-search",
  codex: "codex-web-search",
};

/**
 * The model id a target actually *records*, which is not always the one it is
 * configured with: `exa` writes `exa+<synthesisModel>` (see providers/exa.ts),
 * and the week-over-week join reads the recorded value. Seeded output has to
 * agree with real output here or the two corpora would not join the same way.
 */
export function recordedModel(target: TargetEntry): string {
  if (target.provider === "exa") {
    const synthesis = target.options?.synthesisModel;
    if (typeof synthesis === "string") return `exa+${synthesis}`;
  }
  return target.model;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Deterministic UUID-v4-shaped id, so seeded ids are indistinguishable in shape from `crypto.randomUUID()`. */
function seededId(rng: Rng): string {
  const h = (n: number) => rng.hex(n);
  return `${h(8)}-${h(4)}-4${h(3)}-${rng.pick(["8", "9", "a", "b"])}${h(3)}-${h(12)}`;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "vendor"
  );
}

function shortQuery(prompt: string, rng: Rng): string {
  const words = prompt.replace(/[?"]/g, "").split(/\s+/).filter(Boolean);
  return `${words.slice(0, rng.int(4, 7)).join(" ")} ${rng.pick(QUERY_SUFFIXES)}`;
}

/**
 * Which segment a prompt belongs to. `promptMeta.brandedType` is the declared
 * source (DESIGN §6); the text fallback exists because the branded/unbranded
 * gap is the corpus's largest signal and an unlabelled prompt silently landing
 * in the wrong half would shrink it without erroring.
 */
function promptKind(prompt: PromptEntry, brand: BrandConfig): PromptKind {
  const declared = prompt.meta?.brandedType?.trim().toLowerCase();
  if (declared === "branded" || declared === "unbranded") return declared;
  const haystack = prompt.prompt.toLowerCase();
  return [brand.name, ...brand.aliases].some((name) =>
    haystack.includes(name.toLowerCase()),
  )
    ? "branded"
    : "unbranded";
}

/** The reference description, one sentence at a time, for owned-page snippets. */
function groundTruthSentences(description: string): string[] {
  return (
    description.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()) ?? [description]
  );
}

// ── The corpus ──────────────────────────────────────────────────────────────

/**
 * Render the whole corpus: for every (week × prompt × target), one
 * `UnifiedResult` and — unless that result errored, exactly as the real
 * analyzer skips errored rows — its `ResultVerdict`.
 *
 * Pure. The same `spec` and the same seed always produce the same corpus,
 * byte for byte, on any machine and at any time.
 */
export function buildCorpus(spec: WorldSpec, rng: Rng): SeededCorpus {
  if (spec.weeks < 1) {
    throw new Error(`WorldSpec.weeks must be at least 1, got ${spec.weeks}`);
  }
  if (spec.prompts.length === 0) {
    throw new Error("WorldSpec.prompts is empty — nothing to render");
  }
  if (spec.targets.length === 0) {
    throw new Error("WorldSpec.targets is empty — nothing to render");
  }

  const runs: SeededRun[] = [];

  // Oldest first, most recent last, exactly 7 days apart.
  for (let week = 0; week < spec.weeks; week++) {
    runs.push(
      buildRun(
        spec,
        week,
        shiftDays(spec.anchorDate, -7 * (spec.weeks - 1 - week)),
        rng,
      ),
    );
  }

  return { runs };
}

function buildRun(
  spec: WorldSpec,
  week: number,
  runDate: string,
  rng: Rng,
): SeededRun {
  const runId = seededId(rng);
  const results: UnifiedResult[] = [];
  const verdicts: ResultVerdict[] = [];
  const outageWeek = outageWeekIndex(spec.weeks);
  const outageTarget = outageTargetIndex(spec.targets.length);

  let index = 0;
  for (const prompt of spec.prompts) {
    for (const [targetIndex, target] of spec.targets.entries()) {
      const { result, verdict } = buildCell({
        spec,
        runDate,
        runId,
        prompt,
        target,
        targetIndex,
        position: seriesPosition(week, spec.weeks),
        errored: week === outageWeek && targetIndex === outageTarget,
        index: index++,
        rng,
      });
      results.push(result);
      if (verdict) verdicts.push(verdict);
    }
  }

  return { runDate, runId, results, verdicts };
}

function rankTierFor(rank: BrandRank): RankTier {
  return rank === 1
    ? "leader"
    : rank === 2
      ? "contender"
      : rank === 3
        ? "trailing"
        : "solo";
}

function buildCell(args: {
  spec: WorldSpec;
  runDate: string;
  runId: string;
  prompt: PromptEntry;
  target: TargetEntry;
  targetIndex: number;
  /** 0 at the oldest run, 1 at the newest. */
  position: number;
  errored: boolean;
  index: number;
  rng: Rng;
}): { result: UnifiedResult; verdict: ResultVerdict | null } {
  const {
    spec,
    runDate,
    runId,
    prompt,
    target,
    targetIndex,
    position: t,
    errored,
    index,
    rng,
  } = args;
  const { brand } = spec;
  const model = recordedModel(target);
  const profile = providerProfile(targetIndex);

  const id = seededId(rng);
  const offset = index * SECONDS_BETWEEN_RESULTS;
  const latencyMs = rng.int(1_800, 21_000);
  const startedAt = stampAt(runDate, RUN_START_HOUR_UTC, offset);
  const completedAt = stampAt(
    runDate,
    RUN_START_HOUR_UTC,
    offset + Math.round(latencyMs / 1000),
  );

  const metadataBase = {
    provider: target.provider,
    model,
    searchTool: SEARCH_TOOLS[target.provider] ?? target.provider,
    startedAt,
    completedAt,
    latencyMs,
    runId,
  };

  // The one-week outage. The real pipeline writes the row and the real analyzer
  // refuses to judge it, so neither does this — which is what makes the
  // exclusion of errored results from every cohort and denominator visible on
  // the dashboard rather than merely documented.
  if (errored) {
    return {
      result: {
        id,
        prompt: prompt.prompt,
        promptCategory: prompt.category,
        promptMeta: prompt.meta,
        searchQueries: [],
        searchResults: [],
        responseText: "",
        citations: [],
        metadata: { ...metadataBase, tokenUsage: {} },
        error: {
          code: "HTTP_503",
          message: `${target.provider} returned 503 Service Unavailable`,
          retryable: false,
          retriesAttempted: 2,
        },
      },
      verdict: null,
    };
  }

  const kind = promptKind(prompt, brand);

  // ── Verdict state first. Prose is derived from it below, never drawn
  // alongside it: an excerpt that disagrees with its own result's rank or
  // accuracy is the failure this corpus exists to avoid.
  const mentioned = rng.chance(mentionChance(kind, profile));

  const competitors: CompetitorEntry[] = brand.knownCompetitors.map(
    (name, i) => ({
      name,
      mentioned: rng.chance(competitorChance(i, t, profile)),
      citedUrls: [],
    }),
  );
  const mentionedCompetitors = competitors.filter((c) => c.mentioned);
  const othersCount = mentionedCompetitors.length;
  const othersPresent = othersCount > 0;

  const accuracyScore = mentioned
    ? sampleAccuracy(accuracyMean(t, profile), rng)
    : null;
  const tier = accuracyTier(accuracyScore ?? 3);

  // The overtake, carried into the rank: once the riser has passed us, it takes
  // the top slot in answers where it appears, so the brand cannot be first.
  const riser = riserIndex(brand.knownCompetitors.length);
  const riserAhead =
    riserIsAhead(t) && (competitors[riser]?.mentioned ?? false);

  let brandRank: BrandRank = "not_ranked";
  if (mentioned && othersPresent) {
    if (riserAhead) {
      brandRank = rng.chance(0.55) ? 2 : 3;
    } else {
      brandRank = rng.chance(brandTopChance(t)) ? 1 : rng.chance(0.6) ? 2 : 3;
    }
  }
  const rankTier = rankTierFor(
    mentioned && othersPresent ? brandRank : "not_ranked",
  );

  const book = new Phrasebook();
  const voices: CompetitorVoice[] = mentionedCompetitors.map((c) => {
    const i = brand.knownCompetitors.indexOf(c.name);
    return {
      name: c.name,
      poolIndex: i < 0 ? 0 : i,
      ascendant: i === riser && riserIsAhead(t),
    };
  });

  const { responseText, excerpts } = composeResponse(
    {
      promptKind: kind,
      brand: brand.name,
      mentioned,
      rankTier,
      accuracyTier: tier,
      brandSentences: mentioned
        ? 1 + (othersPresent ? 1 : 0) + (rng.chance(0.3) ? 1 : 0)
        : 0,
      competitors: voices,
    },
    book,
    rng,
  );

  // ── Sources. Owned pages only appear when the brand was actually mentioned,
  // so an owned citation always has prose behind it.
  const searchResults: SearchResult[] = [];
  const ownedUrls: string[] = [];

  const ownedCited =
    mentioned &&
    brand.ownedDomains.length > 0 &&
    rng.chance(ownedCitationChance(tier, profile));

  if (ownedCited) {
    const url = `https://${rng.pick(brand.ownedDomains)}/${rng.pick(["", "pricing", "docs/getting-started", "blog/why"])}`;
    ownedUrls.push(url);
    searchResults.push({
      url,
      title: `${brand.name} — official`,
      snippet:
        book.take(
          groundTruthSentences(brand.groundTruthDescription),
          "",
          rng,
        ) ?? brand.groundTruthDescription,
      score: Math.round(rng.next() * 1000) / 1000,
    });
  }

  for (const competitor of mentionedCompetitors) {
    const url = `https://${slug(competitor.name)}.example/`;
    competitor.citedUrls = [url];
    const voice = voices.find((v) => v.name === competitor.name);
    searchResults.push({
      url,
      title: `${competitor.name} — overview`,
      // A second, different sentence about the same product: three citations
      // quoting one identical string is what a reader notices first.
      snippet:
        book.take(
          COMPETITOR_PREDICATES[
            (voice?.poolIndex ?? 0) % COMPETITOR_PREDICATES.length
          ],
          competitor.name,
          rng,
        ) ??
        `${competitor.name} is covered in most comparisons of this category.`,
      score: Math.round(rng.next() * 1000) / 1000,
    });
  }

  for (const source of rng.sample(GENERIC_SOURCES, rng.int(1, 3))) {
    searchResults.push({
      url: `https://${source.host}/${slug(prompt.prompt).slice(0, 48)}`,
      title: `${source.label}: ${prompt.prompt}`,
      snippet: book.take(source.snippets, "", rng) ?? source.label,
      score: Math.round(rng.next() * 1000) / 1000,
    });
  }

  const cited = rng.sample(
    searchResults,
    rng.int(1, Math.max(1, searchResults.length)),
  );
  // An owned citation that is not in the citation list would be a verdict the
  // result cannot support. `sample` may not have drawn it, so put it back.
  for (const url of ownedUrls) {
    if (!cited.some((s) => s.url === url)) {
      const source = searchResults.find((s) => s.url === url);
      if (source) cited.unshift(source);
    }
  }

  const citations: Citation[] = cited.map((source) => ({
    url: source.url,
    title: source.title,
    citedText: source.snippet ?? "",
  }));

  const searchQueries: SearchQuery[] = [];
  for (let i = 0; i < rng.int(1, 3); i++) {
    searchQueries.push({
      query: shortQuery(prompt.prompt, rng),
      timestamp: stampAt(runDate, RUN_START_HOUR_UTC, offset + i + 1),
    });
  }

  const result: UnifiedResult = {
    id,
    prompt: prompt.prompt,
    promptCategory: prompt.category,
    promptMeta: prompt.meta,
    searchQueries,
    searchResults,
    responseText,
    citations,
    metadata: {
      ...metadataBase,
      tokenUsage: {
        inputTokens: 120 + prompt.prompt.length + rng.int(0, 200),
        outputTokens: Math.ceil(responseText.length / 4) + rng.int(0, 120),
        searchRequests: searchQueries.length,
      },
    },
    error: null,
  };

  const verdict: ResultVerdict = {
    resultId: id,
    prompt: prompt.prompt,
    provider: target.provider,
    model,
    promptCategory: prompt.category ?? null,
    brandMention: {
      mentioned,
      mentionCount: excerpts.length,
      excerpts,
    },
    descriptionAccuracy:
      accuracyScore === null
        ? null
        : {
            score: accuracyScore,
            reasoning: ACCURACY_REASONS[accuracyScore],
          },
    ownedCitation: { cited: ownedUrls.length > 0, urls: ownedUrls },
    competitivePosition: {
      othersPresent,
      othersCount,
      // A brand that was never named cannot hold a rank. Keeping these two in
      // step matters: a rank on an unmentioned brand is exactly the kind of
      // plausible number that reads as real in the dashboard.
      brandRank,
      competitors,
    },
    mentionHypothesis: mentioned
      ? null
      : (book.take(ABSENCE_HYPOTHESES[kind], "", rng) ??
        ABSENCE_HYPOTHESES[kind][0]),
    analyzedAt: stampAt(runDate, ANALYSIS_HOUR_UTC, index),
    judgeModel: spec.judgeModel.model,
    judgeTokens: {
      input: 400 + Math.ceil(responseText.length / 4),
      output: rng.int(60, 260),
    },
  };

  return { result, verdict };
}
