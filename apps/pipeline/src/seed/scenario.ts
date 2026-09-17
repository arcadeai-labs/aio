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
  RawSearchCall,
  ResultVerdict,
  SearchQuery,
  SearchResult,
  TokenUsage,
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
  estimatedCostUsd,
  mentionChance,
  outageTargetIndex,
  outageWeekIndex,
  ownedCitationChance,
  pageAgeDays,
  pageIsDated,
  planPromptMeta,
  providerProfile,
  recordsCitationOffsets,
  recordsEstimatedCost,
  recordsPageDate,
  recordsProviderMeta,
  recordsScore,
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

/**
 * A page's publication date, in the shape the provider reports it: Exa's
 * `publishedDate` is an ISO-8601 instant, Anthropic's `page_age` is a bare
 * date. `search_results.page_date` is a **text** column and nothing parses it,
 * so the corpus carries both shapes rather than normalising away a difference
 * the pipeline never normalises.
 */
function publishedDate(provider: string, day: string): string {
  return provider === "exa" ? `${day}T00:00:00.000Z` : day;
}

/**
 * `metadata.providerMeta` — a free-form bag that reaches no column, written by
 * the two providers that have something provider-specific to say about the
 * call (`providers/anthropic-agent.ts`, `providers/exa.ts`). Keys mirror theirs.
 */
function providerMetaFor(
  target: TargetEntry,
  sourceCount: number,
): Record<string, unknown> {
  if (target.provider === "exa") {
    return {
      synthesisProvider: target.options?.synthesisProvider ?? null,
      synthesisModel: target.options?.synthesisModel ?? null,
      exaResultCount: sourceCount,
    };
  }
  return { sdk: "@anthropic-ai/claude-agent-sdk" };
}

/**
 * `rawSearchCalls` — the verbatim provider payloads, which reach no column
 * (DESIGN §4: structured-only ingest, `raw_ref` reserved for a future
 * lazy-load). The corpus carries the *shape* of the contract, not a replica of
 * any one provider's JSON: enough to exercise every member, including the two
 * a reader is most likely to assume are always filled in.
 *
 * `queryText` is `string | null` because some providers never expose the query
 * they ran — OpenRouter returns annotations with no query and writes
 * `queryText: null` and `rawInput: null` for a single aggregate call. The rest
 * record one call per query. Both arms are in the corpus.
 *
 * Perplexity is a third shape and used to be on the null arm. Since #16 moved
 * it to the Agent API it reports the searches it ran
 * (`output[type=search_results].queries`), so it now writes one aggregate call
 * that *does* carry a query — `queryText` plus a `rawInput.queries` array. Kept
 * faithful because the whole point of the seeded corpus is that synthetic rows
 * exercise the same shapes real ones do; leaving Perplexity on the null arm
 * would model a provider that no longer exists.
 */
function rawCalls(
  provider: string,
  queries: SearchQuery[],
  sources: SearchResult[],
): RawSearchCall[] {
  const found = sources.map((s) => ({ url: s.url, title: s.title }));

  if (provider === "openrouter") {
    if (queries.length === 0) return [];
    return [
      {
        callIndex: 0,
        timestamp: queries[0].timestamp,
        queryText: null,
        rawInput: null,
        rawOutput: { citations: found.map((f) => f.url), results: found },
      },
    ];
  }

  // One aggregate call that names its queries — see `providers/perplexity.ts`,
  // which builds exactly this from each `search_results` output item.
  if (provider === "perplexity") {
    if (queries.length === 0) return [];
    return [
      {
        callIndex: 0,
        timestamp: queries[0].timestamp,
        queryText: queries[0].query,
        rawInput: { queries: queries.map((q) => q.query) },
        rawOutput: { results: found },
      },
    ];
  }

  return queries.map((query, callIndex) => ({
    callIndex,
    timestamp: query.timestamp,
    queryText: query.query,
    rawInput: { query: query.query },
    rawOutput: { results: found },
  }));
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
function promptKind(prompt: PlannedPrompt, brand: BrandConfig): PromptKind {
  const declared = prompt.promptMeta?.brandedType?.trim().toLowerCase();
  if (declared === "branded" || declared === "unbranded") return declared;
  const haystack = prompt.text.toLowerCase();
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

// ── The prompt dimension ────────────────────────────────────────────────────

/**
 * A prompt as the corpus renders it: the loaded entry, plus the
 * `promptCategory` / `promptMeta` the records should carry. `world.ts` decides
 * which prompt plays which role; this only applies the decision.
 *
 * The plan is drawn **once, before the first week**, so a prompt's meta is
 * byte-identical in all fifteen runs — as a prompt sheet's would be, and as
 * `packages/ingest/src/transform.ts` assumes when it builds the `prompts` row
 * from whichever result for that prompt it sees first in a run.
 */
interface PlannedPrompt {
  text: string;
  promptCategory: string | undefined;
  promptMeta: Record<string, string> | undefined;
}

function planPrompts(prompts: PromptEntry[], rng: Rng): PlannedPrompt[] {
  return prompts.map((entry, index) => {
    const plan = planPromptMeta(index, prompts.length, rng);
    const promptCategory = plan.omitCategory ? undefined : entry.category;

    if (plan.omitMeta) {
      return { text: entry.prompt, promptCategory, promptMeta: undefined };
    }

    // The CSV's own keys are carried through untouched; `labels` and
    // `location` are added on top, standing in for the columns the shipped
    // `prompts/default.csv` does not have.
    const meta: Record<string, string> = { ...entry.meta };
    if (plan.labels !== null) meta.labels = plan.labels;
    if (plan.location !== null) meta.location = plan.location;

    return {
      text: entry.prompt,
      promptCategory,
      promptMeta: Object.keys(meta).length > 0 ? meta : undefined,
    };
  });
}

// ── Citation offsets ────────────────────────────────────────────────────────

interface Span {
  start: number;
  end: number;
}

/**
 * Sentence spans of `text`, as `[start, end)` offsets into it.
 *
 * `providers/openai.ts` and `providers/openrouter.ts` both set
 * `citedText = responseText.slice(startIndex, endIndex)`, so an offset here has
 * to resolve against the response it sits on. An offset into nothing is its own
 * silent defect: the column would be populated, the query would return a
 * number, and the excerpt it points at would not exist.
 */
function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(/[^.!?]+[.!?]+/g)) {
    const start = match.index + (match[0].length - match[0].trimStart().length);
    const end = match.index + match[0].trimEnd().length;
    if (end > start) spans.push({ start, end });
  }
  return spans;
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

  // Drawn before the first week so every run repeats the same prompt sheet.
  const prompts = planPrompts(spec.prompts, rng);

  const runs: SeededRun[] = [];

  // Oldest first, most recent last, exactly 7 days apart.
  for (let week = 0; week < spec.weeks; week++) {
    runs.push(
      buildRun(
        spec,
        prompts,
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
  prompts: PlannedPrompt[],
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
  for (const prompt of prompts) {
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
  prompt: PlannedPrompt;
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
        prompt: prompt.text,
        promptCategory: prompt.promptCategory,
        promptMeta: prompt.promptMeta,
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

  // `score` and `pageDate` are populated by exactly the providers that populate
  // them for real — Exa returns a relevance score, Exa and Anthropic report a
  // publication date — so `score IS NULL` reads as "this provider does not
  // score", which is what it means on a real run. See world.ts §7.
  const scored = recordsScore(target.provider);
  const dated = recordsPageDate(target.provider);
  const sourceExtras = (): Pick<SearchResult, "score" | "pageDate"> => {
    const extras: Pick<SearchResult, "score" | "pageDate"> = {};
    if (scored) extras.score = Math.round(rng.next() * 1000) / 1000;
    if (dated && pageIsDated(rng)) {
      extras.pageDate = publishedDate(
        target.provider,
        shiftDays(runDate, -pageAgeDays(rng)),
      );
    }
    return extras;
  };

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
      ...sourceExtras(),
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
      ...sourceExtras(),
    });
  }

  for (const source of rng.sample(GENERIC_SOURCES, rng.int(1, 3))) {
    searchResults.push({
      url: `https://${source.host}/${slug(prompt.text).slice(0, 48)}`,
      title: `${source.label}: ${prompt.text}`,
      snippet: book.take(source.snippets, "", rng) ?? source.label,
      ...sourceExtras(),
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

  // OpenAI and OpenRouter annotate the answer itself: each citation carries the
  // offsets of the span that referenced the URL, and `citedText` is that span,
  // verbatim (`providers/openai.ts`, `providers/openrouter.ts`). The other four
  // quote the source's own snippet and carry no offsets at all. Both shapes are
  // in the corpus, and where the offsets exist they resolve — `citedText` is
  // sliced out of `responseText` here rather than written alongside it, so the
  // two cannot drift apart.
  //
  // One annotation per span, in the order the answer reaches them: a source
  // past the last sentence is left unannotated rather than made to share a
  // span, which keeps "no two citations on one result quote the same string"
  // true of the whole corpus. On the shipped corpus that tail is one result in
  // 480.
  const spans = recordsCitationOffsets(target.provider)
    ? rng.sample(sentenceSpans(responseText), cited.length)
    : [];
  const citations: Citation[] = cited.map((source, i) => {
    const span = spans[i];
    if (!span) {
      return {
        url: source.url,
        title: source.title,
        citedText: source.snippet ?? "",
      };
    }
    return {
      url: source.url,
      title: source.title,
      citedText: responseText.slice(span.start, span.end),
      startIndex: span.start,
      endIndex: span.end,
    };
  });

  const searchQueries: SearchQuery[] = [];
  for (let i = 0; i < rng.int(1, 3); i++) {
    searchQueries.push({
      query: shortQuery(prompt.text, rng),
      timestamp: stampAt(runDate, RUN_START_HOUR_UTC, offset + i + 1),
    });
  }

  const tokenUsage: TokenUsage = {
    inputTokens: 120 + prompt.text.length + rng.int(0, 200),
    outputTokens: Math.ceil(responseText.length / 4) + rng.int(0, 120),
    searchRequests: searchQueries.length,
  };

  const result: UnifiedResult = {
    id,
    prompt: prompt.text,
    promptCategory: prompt.promptCategory,
    promptMeta: prompt.promptMeta,
    searchQueries,
    searchResults,
    responseText,
    citations,
    rawSearchCalls: rawCalls(target.provider, searchQueries, searchResults),
    metadata: {
      ...metadataBase,
      tokenUsage,
      // Only the agent provider meters itself, and only it reports a cost
      // (`providers/anthropic-agent.ts`). The value is derived from the token
      // counts above rather than drawn beside them: the result page prints
      // both, and a cost that disagreed with its own tokens would be the kind
      // of plausible number nobody can falsify by looking.
      ...(recordsEstimatedCost(target.provider)
        ? {
            estimatedCostUsd: estimatedCostUsd({
              inputTokens: tokenUsage.inputTokens ?? 0,
              outputTokens: tokenUsage.outputTokens ?? 0,
              searchRequests: tokenUsage.searchRequests ?? 0,
            }),
          }
        : {}),
      ...(recordsProviderMeta(target.provider)
        ? { providerMeta: providerMetaFor(target, searchResults.length) }
        : {}),
    },
    error: null,
  };

  const verdict: ResultVerdict = {
    resultId: id,
    prompt: prompt.text,
    provider: target.provider,
    model,
    promptCategory: prompt.promptCategory ?? null,
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
