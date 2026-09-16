// The phrasebook. Every sentence the seeded corpus can say, and the rule that
// decides which ones it says.
//
// The rule is the whole point: **prose is a function of verdict state, not a
// parallel random draw.** #2's placeholder generator drew sentences
// independently of the verdict and produced excerpts reading "Taskwell is the
// option reviewers reach for first" on a result whose own verdict recorded
// `brandRank: 3`. Over two flat weeks that is cosmetic. Over fifteen weeks with
// a competitor overtake it destroys the thing the corpus exists to show: the
// excerpts, which surface directly in the UI, would keep insisting the brand is
// reached for first while the competitive chart shows it being passed.
//
// So the pools below are keyed by the state that produced them — the brand's
// rank tier and the accuracy band the judge scored — and a sentence can only be
// drawn from the pool matching its own result. A rank-3 result cannot emit a
// leader sentence, and a 2/5 result cannot emit a sentence that describes the
// product correctly, because neither sentence is in reach.
//
// Two hygiene properties come from `Phrasebook` rather than from the pools: no
// template is used twice within one result, so no sentence repeats inside a
// response and no two brands ever share a predicate. #2 shipped both faults —
// one response carried the same sentence twice, and "is the more opinionated
// choice" was pasted onto three different products in a single paragraph.
//
// PURITY CONTRACT: as `scenario.ts`. Templates and pure string assembly only.
import type { Rng } from "./rng.js";
import type { AccuracyTier, PromptKind } from "./world.js";

/** Where the brand sits when other products are in the answer. */
export type RankTier = "leader" | "contender" | "trailing" | "solo";

/**
 * `{x}` is the subject — the brand or a competitor. Tracking the *template*
 * rather than the rendered sentence is what makes "no two brands share a
 * predicate" enforceable: two products can only collide by drawing the same
 * template, and a template is drawn at most once per result.
 */
const SUBJECT = "{x}";

export function fill(template: string, subject: string): string {
  return template.replaceAll(SUBJECT, subject);
}

/**
 * A per-result record of which templates have been spent. One instance covers a
 * whole result — response body *and* citation snippets — so a source cannot
 * quote a sentence the answer already used, which is the other duplication #2
 * shipped (the same string as the snippet for three different citations).
 */
export class Phrasebook {
  private readonly used = new Set<string>();

  /**
   * An unused template from `pool`, rendered for `subject`. Returns null when
   * the pool is exhausted — callers treat that as "say nothing more" rather
   * than repeat themselves.
   */
  take(pool: readonly string[], subject: string, rng: Rng): string | null {
    const free = pool.filter((template) => !this.used.has(template));
    if (free.length === 0) return null;
    const template = rng.pick(free);
    this.used.add(template);
    return fill(template, subject);
  }
}

// ── The brand, by rank ──────────────────────────────────────────────────────
// Read down the four pools and the overtake is legible in the prose alone.

export const BRAND_POSITION: Record<RankTier, readonly string[]> = {
  leader: [
    "{x} is the first name most of these round-ups put forward.",
    "{x} tops the shortlist in nearly every comparison worth reading.",
    "If you only trial one, the coverage points at {x}.",
    "{x} holds the top slot in this category across current write-ups.",
  ],
  contender: [
    "{x} lands just behind the category leader in most comparisons.",
    "{x} is a regular on the shortlist without often being the headline pick.",
    "{x} is the name people reach for second, after the obvious incumbent.",
    "Reviewers keep {x} in the running but stop short of putting it first.",
  ],
  trailing: [
    "{x} still gets named, though it sits well down the list now.",
    "{x} turns up toward the end of these round-ups rather than the top.",
    "{x} reads as an also-ran in most of the current comparisons.",
    "Few write-ups rank {x} above the two or three names ahead of it.",
  ],
  solo: [
    "{x} is the tool that fits this question most directly.",
    "{x} is worth a look here, and the coverage rarely reaches past it.",
    "For this specific need, {x} is the one that keeps coming up.",
    "{x} answers this without much competition in what gets published.",
  ],
};

// ── The brand, by how accurately it is described ─────────────────────────────
// `high` tracks the config's groundTruthDescription; `low` contradicts it, in
// the specific ways a model conflates a small cross-platform to-do app with the
// enterprise suites around it. An excerpt on an early 2/5 result and one on a
// late 5/5 result must not read alike, and these do not.

export const BRAND_DESCRIPTION: Record<AccuracyTier, readonly string[]> = {
  high: [
    "{x} is a cross-platform to-do app with natural-language capture, recurring tasks and offline-first sync across iOS, Android and the web.",
    "{x} covers the basics properly: natural-language entry, repeating tasks, and shared project lists for small teams.",
    "{x} is aimed at individuals and small teams, with offline-first sync and shared lists rather than heavyweight project tracking.",
    "{x} handles recurring work and natural-language dates, and keeps everything in sync offline across phone and web.",
  ],
  mixed: [
    "{x} is a task app with the usual lists and reminders; the sync story is harder to pin down from the coverage.",
    "{x} does to-dos and repeating items, though sources disagree on how much team collaboration it actually supports.",
    "{x} is described as a personal task manager, with little said about how it behaves offline or across devices.",
    "{x} appears to cover lists, due dates and reminders, but the detail thins out past that.",
  ],
  low: [
    "{x} is usually described as a team project-tracking suite with Gantt charts and workload planning.",
    "{x} reads like a note-taking and wiki tool that happens to keep a task list.",
    "{x} is presented as an enterprise work-management platform sold by seat to large organisations.",
    "{x} comes across as a web-only tool with no mobile apps and no offline mode.",
  ],
};

/**
 * What an answer says when it does not name the brand at all. These carry no
 * `{x}`: a response that never mentioned the brand must never contain its name,
 * or "mentioned: false" would be a verdict its own prose contradicts.
 */
export const BRAND_ABSENT: Record<PromptKind, readonly string[]> = {
  branded: [
    "There is not much reliable published information about that particular product.",
    "I could not find current coverage that describes it in any detail.",
    "The sources available do not say enough about it to answer this confidently.",
  ],
  unbranded: [
    "The names below are the ones the current coverage actually converges on.",
    "Nothing outside the established shortlist came up in what is published.",
  ],
};

/** Judge reasoning, matched to the band the description sentences came from. */
export const ACCURACY_REASONS: Record<number, string> = {
  5: "Matches the reference description on every material point.",
  4: "Accurate overall; one capability is described more loosely than the reference.",
  3: "Broadly right, but thin on detail and omits part of the reference description.",
  2: "Several claims drift from the reference description.",
  1: "Materially misdescribes the product.",
};

// ── Competitors ─────────────────────────────────────────────────────────────
// One disjoint pool per position in `knownCompetitors`, so the incumbent and
// the newcomer are not described interchangeably. Pools are assigned by index
// and wrap, and `Phrasebook` stops two products sharing a template even when
// they wrap onto the same pool.

export const COMPETITOR_PREDICATES: readonly (readonly string[])[] = [
  [
    "{x} is the default recommendation in this category.",
    "{x} is the one most people have already tried at some point.",
    "{x} remains the safe answer if you do not want to think about it.",
  ],
  [
    "{x} is the pick for people who want something deliberately minimal.",
    "{x} appeals to readers who like a tidy, opinionated design.",
    "{x} suits anyone who would rather have fewer knobs to turn.",
  ],
  [
    "{x} has been picking up recommendations steadily over the past few months.",
    "{x} keeps appearing higher in these lists than it used to.",
    "{x} has grown a following well out of proportion to its price.",
  ],
  [
    "{x} gets suggested when the question turns out to be about documents and databases.",
    "{x} is the answer for people who want one workspace for everything.",
    "{x} is flexible enough to become a task manager if you build it that way.",
  ],
  [
    "{x} is where people land once the team is bigger than a handful of people.",
    "{x} is built around projects and assignees rather than personal lists.",
    "{x} is the one managers tend to bring with them.",
  ],
  [
    "{x} is the budget-conscious fallback on most of these lists.",
    "{x} covers the essentials without asking for a subscription.",
    "{x} is the one people recommend when cost is the constraint.",
  ],
  [
    "{x} comes up whenever platform coverage is the real constraint.",
    "{x} is the option that works the same on every device someone owns.",
    "{x} is recommended for households already standardised on one ecosystem.",
  ],
  [
    "{x} is the one already installed on the device in question.",
    "{x} wins on not having to be set up at all.",
    "{x} is good enough that plenty of people never look further.",
  ],
];

/**
 * Reserved for the riser, and only once the numbers say it has passed us. The
 * chart and the sentences move together: nothing here can be said in week one.
 */
export const RISER_ASCENDANT: readonly string[] = [
  "{x} has moved past most of the field in this year's round-ups.",
  "{x} now opens the comparisons that used to start with someone else.",
  "{x} has taken the top slot on more of these lists than anyone expected a year ago.",
  "{x} is the name that has gained the most ground in this category recently.",
];

// ── Frame ───────────────────────────────────────────────────────────────────

export const OPENERS: Record<PromptKind, readonly string[]> = {
  branded: [
    "Here is what the current write-ups say.",
    "The coverage is thinner than for the bigger names, but there is some.",
    "Here is what reviewers and users have published so far.",
    "This is what the available reviews and round-ups support.",
  ],
  unbranded: [
    "A few tools come up consistently for this.",
    "Most round-ups converge on the same short list.",
    "There are several credible options, and the right one depends on how you work.",
    "This comes down to a handful of well-established apps.",
    "The shortlist has been fairly stable, with one or two newer names climbing it.",
  ],
};

export const CLOSERS: readonly string[] = [
  "Any of these will do the job; the differences show up after a few weeks of use.",
  "Trial the shortlist before committing — the workflows diverge more than the feature lists suggest.",
  "Pricing and platform coverage are usually the deciding factors.",
  "Most of the real difference is in how each one handles capture and recurring work.",
  "Worth checking which of these your calendar and inbox already connect to.",
  "Export and lock-in are the things people wish they had checked first.",
];

/** Absence hypotheses, keyed by the shape of the question that went unanswered. */
export const ABSENCE_HYPOTHESES: Record<PromptKind, readonly string[]> = {
  branded: [
    "Prompt named the brand, but retrieval returned no page describing it.",
    "The answer hedged rather than describe a product it could not source.",
    "No owned or high-authority page surfaced for a directly branded question.",
  ],
  unbranded: [
    "Answer stayed with the incumbents; the brand did not surface in retrieval.",
    "No owned or high-authority source appeared among the cited pages.",
    "Prompt was answered generically, without naming specific products.",
    "The competitive set filled the shortlist before the brand was reached.",
  ],
};

// ── Sources ─────────────────────────────────────────────────────────────────
// Each source gets its own snippet pool, so three citations on one result can
// never quote an identical string the way #2's did.

export interface GenericSource {
  host: string;
  label: string;
  snippets: readonly string[];
}

export const GENERIC_SOURCES: readonly GenericSource[] = [
  {
    host: "roundup.example",
    label: "The Annual Round-Up",
    snippets: [
      "We re-tested every app on this list in the last quarter and reordered it twice.",
      "Our shortlist changed more this year than in the three before it.",
      "Ranking weighs capture speed and sync reliability above feature count.",
    ],
  },
  {
    host: "reviews.example",
    label: "Independent Reviews",
    snippets: [
      "Scores here come from two weeks of daily use, not a feature matrix.",
      "We mark down anything that loses a task when the network drops.",
      "Reviewers split on whether the cheaper tiers are usable day to day.",
    ],
  },
  {
    host: "forum.example",
    label: "Community Forum",
    snippets: [
      "Thread has 400-odd replies and the recommendations have shifted over it.",
      "Most people posting here switched from something else within the last year.",
      "The recurring-task handling is what the long-time posters argue about.",
    ],
  },
  {
    host: "guides.example",
    label: "Buyer's Guides",
    snippets: [
      "Pick on how you capture tasks; everything else is negotiable later.",
      "Team plans and personal plans are not the same purchase — decide which one you are making.",
      "Check the export format before you commit a year of tasks to anything.",
    ],
  },
];

export const QUERY_SUFFIXES: readonly string[] = [
  "review 2026",
  "comparison",
  "best options",
  "pricing",
  "alternatives",
];

// ── Composition ─────────────────────────────────────────────────────────────

/** A competitor as the composer sees it: a name and the pool it draws from. */
export interface CompetitorVoice {
  name: string;
  /** Index into `COMPETITOR_PREDICATES` (wraps). */
  poolIndex: number;
  /** True only for the riser, and only once it has actually passed the brand. */
  ascendant: boolean;
}

export interface ResponsePlan {
  promptKind: PromptKind;
  brand: string;
  mentioned: boolean;
  rankTier: RankTier;
  accuracyTier: AccuracyTier;
  /** How many sentences about the brand to aim for (1–3). */
  brandSentences: number;
  /** Mentioned competitors, in config order. */
  competitors: CompetitorVoice[];
}

export interface ComposedResponse {
  responseText: string;
  /** Exact substrings of `responseText`: the sentences naming the brand. */
  excerpts: string[];
}

/**
 * Build the answer text and, from the same sentences, the excerpts the judge
 * would have quoted. Excerpts are the brand sentences themselves rather than a
 * second draw, so "mentioned" can never be true over prose that does not name
 * the brand — and, because those sentences come from pools keyed by the
 * verdict, an excerpt can never contradict the verdict it sits on.
 */
export function composeResponse(
  plan: ResponsePlan,
  book: Phrasebook,
  rng: Rng,
): ComposedResponse {
  const opener = book.take(OPENERS[plan.promptKind], "", rng);

  const brandSentences: string[] = [];
  if (plan.mentioned) {
    const describe = () =>
      book.take(BRAND_DESCRIPTION[plan.accuracyTier], plan.brand, rng);
    const place = () =>
      book.take(BRAND_POSITION[plan.rankTier], plan.brand, rng);

    // Description first: it is the sentence the accuracy score is a judgement
    // of, so every mentioned result has one. The placing sentence comes from
    // the tier the verdict recorded — including `solo`, which is what an answer
    // that named no competitor is entitled to say.
    const order = [describe, place, describe];
    for (const draw of order.slice(0, Math.max(1, plan.brandSentences))) {
      const sentence = draw();
      if (sentence) brandSentences.push(sentence);
    }
  }

  const competitorSentences: string[] = [];
  for (const competitor of plan.competitors) {
    const pool = competitor.ascendant
      ? RISER_ASCENDANT
      : COMPETITOR_PREDICATES[
          competitor.poolIndex % COMPETITOR_PREDICATES.length
        ];
    const sentence =
      book.take(pool, competitor.name, rng) ??
      book.take(
        COMPETITOR_PREDICATES[
          (competitor.poolIndex + 1) % COMPETITOR_PREDICATES.length
        ],
        competitor.name,
        rng,
      );
    if (sentence) competitorSentences.push(sentence);
  }

  // Where the brand sits in the paragraph tracks where it sits in the ranking.
  // A trailing brand named in the first sentence would contradict its own
  // verdict as loudly as a leader sentence would.
  const body: string[] = [];
  if (!plan.mentioned) {
    const absent = book.take(BRAND_ABSENT[plan.promptKind], "", rng);
    if (absent) body.push(absent);
    body.push(...competitorSentences);
  } else if (plan.rankTier === "leader" || plan.rankTier === "solo") {
    body.push(...brandSentences, ...competitorSentences);
  } else if (plan.rankTier === "contender") {
    body.push(
      ...competitorSentences.slice(0, 1),
      ...brandSentences,
      ...competitorSentences.slice(1),
    );
  } else {
    body.push(...competitorSentences, ...brandSentences);
  }

  const closer = book.take(CLOSERS, "", rng);
  const sentences = [opener, ...body, closer].filter(
    (s): s is string => s !== null,
  );

  return { responseText: sentences.join(" "), excerpts: brandSentences };
}
