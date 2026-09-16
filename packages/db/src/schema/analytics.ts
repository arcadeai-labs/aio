// Analytics schema — the normalized, structured-only model behind the
// brand-presence dashboard (issue #4). Source of truth for both reads (web) and
// writes (ingest).
//
// Shape mirrors DASHBOARD_SPEC.md §4:
//   - Dimensions  (cross-week, upserted; never deleted by a run replace)
//   - Facts       (per-run, wholesale-replaced on re-ingest of that run)
//   - Config      (per-run snapshots; file→DB import-only in v1)
//   - Provenance  (ingest_runs — drives reconciliation + UI freshness)
//
// Canonical naming corrects the source trap (see spec §6): the source field
// `promptCategory` carries the THEME; the source CSV `category` /
// `promptMeta.brandedType` carries the BRANDED_TYPE.
//
// Children of `results`/`config_snapshots` use ON DELETE CASCADE so a per-run
// wholesale replace (delete the run's results/verdicts, re-insert) leaves no
// orphans — no diffing required.

import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// ── Dimensions ──────────────────────────────────────────────────────────────

// Identity: prompt_id = hash(normalized_text), normalization = trim + collapse
// internal whitespace + lowercase. A reworded prompt is intentionally a *new*
// prompt. theme / branded_type / location carry the LATEST-SEEN classification
// for default grouping; the as-run facts live on `results`.
export const prompts = pgTable("prompts", {
  promptId: text("prompt_id").primaryKey(),
  text: text("text").notNull(),
  normalizedText: text("normalized_text").notNull(),
  theme: text("theme"),
  brandedType: text("branded_type"), // 'branded' | 'unbranded'
  isRelevant: boolean("is_relevant").notNull().default(true),
  location: text("location"),
  firstSeenRun: date("first_seen_run").notNull(),
  lastSeenRun: date("last_seen_run").notNull(),
});

// Parsed from comma-joined `promptMeta.labels`. Modeled but not surfaced in v1.
export const promptLabels = pgTable(
  "prompt_labels",
  {
    promptId: text("prompt_id")
      .notNull()
      .references(() => prompts.promptId, { onDelete: "cascade" }),
    label: text("label").notNull(),
  },
  (t) => [primaryKey({ columns: [t.promptId, t.label] })],
);

// ── Facts (per-run, wholesale-replaced) ──────────────────────────────────────

export const results = pgTable(
  "results",
  {
    id: text("id").primaryKey(), // source UnifiedResult UUID
    runDate: date("run_date").notNull(),
    promptId: text("prompt_id")
      .notNull()
      .references(() => prompts.promptId),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    responseText: text("response_text").notNull().default(""),
    searchTool: text("search_tool"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    estimatedCostUsd: doublePrecision("estimated_cost_usd"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    hasError: boolean("has_error").notNull().default(false),
    // As-run facts (classification can drift run-to-run; dimension holds
    // latest-seen, the result row holds what was true for this run).
    runBrandedType: text("run_branded_type"),
    runTheme: text("run_theme"),
    rawRef: text("raw_ref"), // reserved: future lazy-load of raw payloads
  },
  (t) => [
    index("results_run_date_provider_idx").on(t.runDate, t.provider),
    index("results_prompt_id_idx").on(t.promptId),
  ],
);

export const searchQueries = pgTable(
  "search_queries",
  {
    id: serial("id").primaryKey(),
    resultId: text("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    query: text("query").notNull(),
    ts: timestamp("ts", { withTimezone: true }),
  },
  (t) => [index("search_queries_result_id_idx").on(t.resultId)],
);

export const searchResults = pgTable(
  "search_results",
  {
    id: serial("id").primaryKey(),
    resultId: text("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    title: text("title"),
    snippet: text("snippet"),
    score: doublePrecision("score"),
    pageDate: text("page_date"),
  },
  (t) => [index("search_results_result_id_idx").on(t.resultId)],
);

export const citations = pgTable(
  "citations",
  {
    id: serial("id").primaryKey(),
    resultId: text("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    title: text("title"),
    citedText: text("cited_text"),
    startIndex: integer("start_index"),
    endIndex: integer("end_index"),
  },
  (t) => [index("citations_result_id_idx").on(t.resultId)],
);

// One verdict per result (deduped at load by latest analyzedAt).
export const verdicts = pgTable(
  "verdicts",
  {
    resultId: text("result_id")
      .primaryKey()
      .references(() => results.id, { onDelete: "cascade" }),
    promptId: text("prompt_id")
      .notNull()
      .references(() => prompts.promptId),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    mentioned: boolean("mentioned").notNull(),
    mentionCount: integer("mention_count").notNull().default(0),
    accuracyScore: integer("accuracy_score"), // 1–5, null when not mentioned
    accuracyReasoning: text("accuracy_reasoning"),
    ownedCited: boolean("owned_cited").notNull(),
    othersPresent: boolean("others_present").notNull(),
    othersCount: integer("others_count").notNull().default(0),
    brandRank: text("brand_rank").notNull(), // '1' | '2' | '3' | 'not_ranked'
    mentionHypothesis: text("mention_hypothesis"),
    analyzedAt: timestamp("analyzed_at", { withTimezone: true }),
    judgeModel: text("judge_model"),
    judgeInputTokens: integer("judge_input_tokens"),
    judgeOutputTokens: integer("judge_output_tokens"),
  },
  (t) => [index("verdicts_prompt_id_idx").on(t.promptId)],
);

export const verdictExcerpts = pgTable(
  "verdict_excerpts",
  {
    id: serial("id").primaryKey(),
    resultId: text("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    excerpt: text("excerpt").notNull(),
  },
  (t) => [index("verdict_excerpts_result_id_idx").on(t.resultId)],
);

export const verdictOwnedUrls = pgTable(
  "verdict_owned_urls",
  {
    id: serial("id").primaryKey(),
    resultId: text("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
  },
  (t) => [index("verdict_owned_urls_result_id_idx").on(t.resultId)],
);

// Only mentioned=true rows are stored (the source enum lists every competitor on
// every row).
export const competitorMentions = pgTable(
  "competitor_mentions",
  {
    id: serial("id").primaryKey(),
    resultId: text("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    competitorName: text("competitor_name").notNull(),
  },
  (t) => [
    index("competitor_mentions_result_id_idx").on(t.resultId),
    index("competitor_mentions_name_idx").on(t.competitorName),
  ],
);

export const competitorCitedUrls = pgTable(
  "competitor_cited_urls",
  {
    id: serial("id").primaryKey(),
    resultId: text("result_id")
      .notNull()
      .references(() => results.id, { onDelete: "cascade" }),
    competitorName: text("competitor_name").notNull(),
    url: text("url").notNull(),
  },
  (t) => [index("competitor_cited_urls_result_id_idx").on(t.resultId)],
);

// ── Config (per-run snapshots; file→DB import-only in v1) ─────────────────────

export const configSnapshots = pgTable("config_snapshots", {
  id: serial("id").primaryKey(),
  runDate: date("run_date").notNull().unique(),
  brandName: text("brand_name").notNull(),
  groundTruthDescription: text("ground_truth_description"),
  judgeProvider: text("judge_provider"),
  judgeModel: text("judge_model"),
  raw: jsonb("raw"),
  capturedAt: timestamp("captured_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const configOwnedDomains = pgTable("config_owned_domains", {
  id: serial("id").primaryKey(),
  snapshotId: integer("snapshot_id")
    .notNull()
    .references(() => configSnapshots.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  active: boolean("active").notNull().default(true),
  addedAt: timestamp("added_at", { withTimezone: true }),
  removedAt: timestamp("removed_at", { withTimezone: true }),
});

export const configCompetitors = pgTable("config_competitors", {
  id: serial("id").primaryKey(),
  snapshotId: integer("snapshot_id")
    .notNull()
    .references(() => configSnapshots.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
});

export const configAliases = pgTable("config_aliases", {
  id: serial("id").primaryKey(),
  snapshotId: integer("snapshot_id")
    .notNull()
    .references(() => configSnapshots.id, { onDelete: "cascade" }),
  alias: text("alias").notNull(),
});

// ── Provenance ────────────────────────────────────────────────────────────────

// One row per ingested run. Source hashes drive reconciliation (§5): a run is
// re-ingested iff its file hashes differ from the recorded ones. Counts + status
// + timestamp power per-run freshness in the UI.
export const ingestRuns = pgTable("ingest_runs", {
  runDate: date("run_date").primaryKey(),
  resultsFileHash: text("results_file_hash").notNull(),
  analysisFileHash: text("analysis_file_hash"),
  resultCount: integer("result_count").notNull().default(0),
  verdictCount: integer("verdict_count").notNull().default(0),
  orphanVerdictCount: integer("orphan_verdict_count").notNull().default(0),
  status: text("status").notNull().default("ok"),
  ingestedAt: timestamp("ingested_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
