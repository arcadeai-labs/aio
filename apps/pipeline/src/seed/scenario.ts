// The deep module of `bun run seed`: a world spec plus an RNG in, the complete
// two-record corpus out. Everything later — the narrative arc in #3, any richer
// world model — lands here, so the interface is the deliverable and the numbers
// below are deliberately flat.
//
// PURITY CONTRACT (asserted by apps/pipeline/test/seed-scenario.test.ts):
// the import block below is the whole of this module's outside world. No
// `node:fs`, no `node:path`, no network client, no `Date.now()`, no
// `Math.random()`. Every value that varies comes from the injected `Rng`, and
// every date is derived from `spec.anchorDate`. A corpus that depended on the
// clock would not be reproducible, and reproducibility is the point.
import type {
  BrandConfig,
  Citation,
  CompetitorEntry,
  JudgeModelConfig,
  ResultVerdict,
  SearchQuery,
  SearchResult,
  UnifiedResult,
} from "@aio/core";
import type { PromptEntry, TargetEntry } from "../types/config.js";
import type { Rng } from "./rng.js";

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

// ── World constants ─────────────────────────────────────────────────────────
// Flat on purpose. #3 replaces the world model wholesale; tuning these here
// buys a corpus that is thrown away. They only need to keep every cohort in the
// dashboard non-empty: some mentions and some misses, some owned citations,
// some competitive answers, and a couple of provider errors so the coverage
// indicator has something to show.
const MENTION_RATE = 0.6;
const OWNED_CITATION_RATE = 0.4;
const COMPETITOR_MENTION_RATE = 0.35;
const ERROR_RATE = 0.03;

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
  perplexity: "perplexity-sonar",
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

// ── Prose fragments ─────────────────────────────────────────────────────────
// Enough variety that two results never read identically and a snippet looks
// like prose. Not enough to be worth admiring — #3 owns what this says.

const OPENERS = [
  "A few tools come up consistently for this.",
  "There are several credible options, and the right one depends on how you work.",
  "Most round-ups converge on the same short list.",
  "This comes down to a handful of well-established apps.",
];

const BRAND_CLAUSES = [
  "is widely recommended for exactly this",
  "shows up in most comparisons of this category",
  "is the option reviewers reach for first",
  "covers this well and is easy to get started with",
  "is a strong fit if you want something that stays out of the way",
];

const COMPETITOR_CLAUSES = [
  "is the more opinionated choice",
  "is often suggested for teams",
  "has a loyal following among power users",
  "trades flexibility for polish",
  "is the budget-conscious pick",
];

const CLOSERS = [
  "Any of these will do the job; the differences show up after a few weeks of use.",
  "Trial the shortlist before committing — the workflows diverge more than the feature lists suggest.",
  "Pricing and platform coverage are usually the deciding factors.",
];

const ACCURACY_REASONS: Record<number, string> = {
  5: "Matches the reference description on every material point.",
  4: "Accurate overall; one capability is described more loosely than the reference.",
  3: "Broadly right, but thin on detail and omits part of the reference description.",
  2: "Several claims drift from the reference description.",
  1: "Materially misdescribes the product.",
};

const ABSENCE_HYPOTHESES = [
  "Answer stayed with the incumbents; the brand did not surface in retrieval.",
  "No owned or high-authority source appeared among the cited pages.",
  "Prompt was answered generically, without naming specific products.",
];

const GENERIC_SOURCES = [
  { host: "roundup.example", label: "The Annual Round-Up" },
  { host: "reviews.example", label: "Independent Reviews" },
  { host: "forum.example", label: "Community Forum" },
  { host: "guides.example", label: "Buyer's Guides" },
];

const QUERY_SUFFIXES = [
  "review 2026",
  "comparison",
  "best options",
  "pricing",
  "alternatives",
];

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

// ── Response composition ────────────────────────────────────────────────────

interface Composed {
  responseText: string;
  /** Exact substrings of `responseText` — the sentences that name the brand. */
  brandExcerpts: string[];
}

/**
 * Build the answer text and, from the same sentences, the excerpts the judge
 * would have quoted. Excerpts are sliced out of the text rather than written
 * alongside it, so "mentioned" can never be true over prose that does not
 * actually name the brand — this project's signature failure runs the other
 * way (a confident zero), and the same discipline catches a confident one.
 */
function compose(
  brand: string,
  mentionedCompetitors: string[],
  mentionCount: number,
  rng: Rng,
): Composed {
  const sentences: string[] = [rng.pick(OPENERS)];
  const brandExcerpts: string[] = [];

  for (let i = 0; i < mentionCount; i++) {
    const sentence = `${brand} ${rng.pick(BRAND_CLAUSES)}.`;
    brandExcerpts.push(sentence);
    sentences.push(sentence);
  }

  for (const competitor of mentionedCompetitors) {
    sentences.push(`${competitor} ${rng.pick(COMPETITOR_CLAUSES)}.`);
  }

  sentences.push(rng.pick(CLOSERS));
  return { responseText: sentences.join(" "), brandExcerpts };
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
  for (let week = spec.weeks - 1; week >= 0; week--) {
    runs.push(buildRun(spec, shiftDays(spec.anchorDate, -7 * week), rng));
  }

  return { runs };
}

function buildRun(spec: WorldSpec, runDate: string, rng: Rng): SeededRun {
  const runId = seededId(rng);
  const results: UnifiedResult[] = [];
  const verdicts: ResultVerdict[] = [];

  let index = 0;
  for (const prompt of spec.prompts) {
    for (const target of spec.targets) {
      const { result, verdict } = buildCell({
        spec,
        runDate,
        runId,
        prompt,
        target,
        index: index++,
        rng,
      });
      results.push(result);
      if (verdict) verdicts.push(verdict);
    }
  }

  return { runDate, runId, results, verdicts };
}

function buildCell(args: {
  spec: WorldSpec;
  runDate: string;
  runId: string;
  prompt: PromptEntry;
  target: TargetEntry;
  index: number;
  rng: Rng;
}): { result: UnifiedResult; verdict: ResultVerdict | null } {
  const { spec, runDate, runId, prompt, target, index, rng } = args;
  const { brand } = spec;
  const model = recordedModel(target);

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

  // A provider that answered with an error. The real pipeline writes the row
  // and the real analyzer refuses to judge it, so neither does this.
  if (rng.chance(ERROR_RATE)) {
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

  const mentioned = rng.chance(MENTION_RATE);
  const mentionCount = mentioned ? rng.int(1, 3) : 0;

  const competitors: CompetitorEntry[] = brand.knownCompetitors.map((name) => ({
    name,
    mentioned: rng.chance(COMPETITOR_MENTION_RATE),
    citedUrls: [],
  }));
  const mentionedCompetitors = competitors.filter((c) => c.mentioned);

  const { responseText, brandExcerpts } = compose(
    brand.name,
    mentionedCompetitors.map((c) => c.name),
    mentionCount,
    rng,
  );

  // ── Sources. Owned pages only appear when the brand was actually mentioned,
  // so an owned citation always has prose behind it.
  const searchResults: SearchResult[] = [];
  const ownedUrls: string[] = [];

  const ownedCited =
    mentioned &&
    brand.ownedDomains.length > 0 &&
    rng.chance(OWNED_CITATION_RATE);

  if (ownedCited) {
    const url = `https://${rng.pick(brand.ownedDomains)}/${rng.pick(["", "pricing", "docs/getting-started", "blog/why"])}`;
    ownedUrls.push(url);
    searchResults.push({
      url,
      title: `${brand.name} — official`,
      snippet: brand.groundTruthDescription.slice(0, 180),
      score: Math.round(rng.next() * 1000) / 1000,
    });
  }

  for (const competitor of mentionedCompetitors) {
    const url = `https://${slug(competitor.name)}.example/`;
    competitor.citedUrls = [url];
    searchResults.push({
      url,
      title: `${competitor.name} — overview`,
      snippet: `${competitor.name} ${rng.pick(COMPETITOR_CLAUSES)}.`,
      score: Math.round(rng.next() * 1000) / 1000,
    });
  }

  for (const source of rng.sample(GENERIC_SOURCES, rng.int(1, 3))) {
    searchResults.push({
      url: `https://${source.host}/${slug(prompt.prompt).slice(0, 48)}`,
      title: `${source.label}: ${prompt.prompt}`,
      snippet: rng.pick(CLOSERS),
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

  const othersCount = mentionedCompetitors.length;
  const accuracyScore = mentioned ? rng.int(2, 5) : null;

  const verdict: ResultVerdict = {
    resultId: id,
    prompt: prompt.prompt,
    provider: target.provider,
    model,
    promptCategory: prompt.category ?? null,
    brandMention: {
      mentioned,
      mentionCount,
      excerpts: brandExcerpts,
    },
    descriptionAccuracy:
      accuracyScore === null
        ? null
        : {
            score: accuracyScore as 1 | 2 | 3 | 4 | 5,
            reasoning: ACCURACY_REASONS[accuracyScore],
          },
    ownedCitation: { cited: ownedUrls.length > 0, urls: ownedUrls },
    competitivePosition: {
      othersPresent: othersCount > 0,
      othersCount,
      // A brand that was never named cannot hold a rank. Keeping these two in
      // step matters: a rank on an unmentioned brand is exactly the kind of
      // plausible number that reads as real in the dashboard.
      brandRank:
        mentioned && othersCount > 0
          ? (rng.int(1, 3) as 1 | 2 | 3)
          : "not_ranked",
      competitors,
    },
    mentionHypothesis: mentioned ? null : rng.pick(ABSENCE_HYPOTHESES),
    analyzedAt: stampAt(runDate, ANALYSIS_HOUR_UTC, index),
    judgeModel: spec.judgeModel.model,
    judgeTokens: {
      input: 400 + Math.ceil(responseText.length / 4),
      output: rng.int(60, 260),
    },
  };

  return { result, verdict };
}
