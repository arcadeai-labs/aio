# Data Schemas

Field-level reference for the JSON the pipeline writes and for what survives the
trip into Postgres.

Each table has a **DB column** column. That is the part worth reading twice: the
ingest transform (`packages/ingest/src/transform.ts`) is where JSONL field names
become column names, and a field can be correct in the TypeScript contract,
correct in the Drizzle schema, and still arrive under a different name — or not
arrive at all. A `—` means **the field is not ingested**: it exists in the file
and has no column to query. Table names are the Drizzle/Postgres names from
`packages/db/src/schema/analytics.ts`.

**Files covered here**

| File | Record | Section |
|------|--------|---------|
| `results/results-YYYY-MM-DD.jsonl` | one `UnifiedResult` per line | [Result](#result-results-yyyy-mm-ddjsonl) |
| `results/analysis/analysis-YYYY-MM-DD.jsonl` | one `ResultVerdict` per line | [Analysis Verdict](#analysis-verdict-analysis-yyyy-mm-ddjsonl) |
| `results/analysis/comparison-YYYY-MM-DD.json` | one `WeekComparison` | [Week Comparison](#week-comparison-comparison-yyyy-mm-ddjson) |
| `results/analysis/learnings/YYYY-MM-DD/<slug>.json` | one `Learning` | [Learning](#learning-learningsyyyy-mm-ddslugjson) |

`analytics.config.json` is **consumed**, not produced, and is documented in
[README.md](README.md#analytics); its per-run snapshot lands in
`config_snapshots` and its child tables. `summary-*.md` and
`tracker-{detail,summary}.csv` are rendered reports, not data contracts.

**Identity, in three rules**

- **A prompt is its text.** `prompt_id = sha256(prompt.trim().replace(/\s+/g," ").toLowerCase())`.
  Editing the wording of an existing prompt does not update a row — it mints a
  new `prompt_id`, starting a new series and silently ending the old one.
- **A run is its date.** In the database a run is keyed by `run_date`, which the
  ingester parses out of the **filename**. `metadata.runId` is a per-batch UUID
  in the file and is not ingested at all.
- **A series is `(prompt, provider, model)`.** Week-over-week matching joins on
  all three, so a model-id change correctly starts a new series rather than
  continuing the old one under a name that no longer describes what answered.

---

## Result (`results-YYYY-MM-DD.jsonl`)

One line per (prompt x provider x model) run. Defined in
`packages/core/src/unified-result.ts`. Ingested into `results` and its child
tables.

### `UnifiedResult`

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `id` | `string` | `results.id` (pk) | UUID for this result |
| `prompt` | `string` | `prompts.text`; hashed into `results.prompt_id` | The question sent to the provider |
| `promptCategory` | `string?` | `results.run_theme`, `prompts.theme` | **The theme**, not the branded/unbranded split — see [the `promptCategory` trap](#the-promptcategory-trap) |
| `promptMeta` | `Record<string, string>?` | three keys only — see [`promptMeta`](#promptmeta) | Extra columns from the prompts CSV |
| `searchQueries` | `SearchQuery[]` | `search_queries` | Queries the provider issued to its search backend |
| `searchResults` | `SearchResult[]` | `search_results` | Web pages returned by the search step |
| `responseText` | `string` | `results.response_text` | The provider's final answer text (`''` on an errored run) |
| `citations` | `Citation[]` | `citations` | URLs the provider explicitly cited in its answer |
| `metadata` | `RunMetadata` | flattened onto `results` | Timing, cost, model info |
| `rawSearchCalls` | `RawSearchCall[]?` | **—** | Verbatim API objects from each search invocation |
| `error` | `RunError \| null` | `results.error_code`, `error_message`, `has_error` | Error details if the call failed, otherwise null. The key is always present |

#### The `promptCategory` trap

`promptCategory` holds the **theme** ("Feature & Capability", "Purchase &
Pricing"). The branded/unbranded classification lives in
`promptMeta.brandedType`. The resolution rule is in
`apps/pipeline/src/load.ts`:

- CSV has a `theme_name` column → `promptCategory = theme_name`, and the CSV's
  `category` column is moved into `promptMeta.brandedType`.
- CSV has no `theme_name` (this is the shipped `prompts/default.csv`) →
  `promptCategory = category`, and `brandedType` passes through as its own CSV
  column.

Either way the canonical DB names are `theme` and `branded_type`, so a query
never has to know which CSV layout produced the run. See DESIGN.md §6.

#### `promptMeta`

Arbitrary key/value from the CSV, but exactly three keys are load-bearing at
ingest. Every other key — including `topic` in the shipped
`prompts/default.csv` — is dropped.

| Key | DB column | Notes |
|-----|-----------|-------|
| `brandedType` | `results.run_branded_type`, `prompts.branded_type` | Lowercased; anything other than `branded`/`unbranded` becomes `NULL` |
| `location` | `prompts.location` | |
| `labels` | `prompt_labels.label` | Comma-separated string, split and de-duped. Modeled, not surfaced in v1 |
| *(anything else)* | **—** | |

### `SearchQuery`

Ingested into `search_queries`, one row per element.

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `query` | `string` | `search_queries.query` | The search query string |
| `timestamp` | `string` | `search_queries.ts` | ISO-8601 time the query was issued; unparseable values become `NULL` |

### `SearchResult`

Ingested into `search_results`, one row per element.

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `url` | `string` | `search_results.url` | URL of the search result |
| `title` | `string` | `search_results.title` | Page title (column is nullable) |
| `snippet` | `string` | `search_results.snippet` | Snippet / summary text (column is nullable) |
| `score` | `number?` | `search_results.score` | Relevance score (when the provider returns one) |
| `pageDate` | `string?` | `search_results.page_date` | Publication date of the page. Only `exa` and `anthropic` populate it |

### `Citation`

Ingested into `citations`, one row per element.

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `url` | `string` | `citations.url` | Cited URL |
| `title` | `string` | `citations.title` | Title of the cited page (column is nullable) |
| `citedText` | `string` | `citations.cited_text` | The passage from the response that references this URL (column is nullable) |
| `startIndex` | `number?` | `citations.start_index` | Character offset where the citation starts in `responseText`. Only `openai` and `openrouter` populate it |
| `endIndex` | `number?` | `citations.end_index` | Character offset where the citation ends in `responseText`. Same providers as above |

### `RunMetadata`

Flattened onto the `results` row.

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `provider` | `string` | `results.provider` | Provider key (openai, anthropic, anthropic-agent, openrouter, perplexity, exa) |
| `model` | `string` | `results.model` | Model identifier **as recorded**, which is not always the configured label: `exa` records `exa+<synthesisModel>` |
| `searchTool` | `string` | `results.search_tool` | Name of the search tool / method |
| `startedAt` | `string` | `results.started_at` | ISO-8601 start time |
| `completedAt` | `string` | `results.completed_at` | ISO-8601 completion time |
| `latencyMs` | `number` | `results.latency_ms` | Wall-clock time in milliseconds |
| `tokenUsage` | `TokenUsage` | see below | Token counts for the run |
| `estimatedCostUsd` | `number?` | `results.estimated_cost_usd` | Estimated API cost in USD. **Only `anthropic-agent` populates it** — `NULL` for the other five providers |
| `runId` | `string` | **—** | UUID for the overall run batch. One per dated file; the DB keys runs by `run_date` instead |
| `providerMeta` | `Record<string, unknown>?` | **—** | Provider-specific metadata |

### `TokenUsage`

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `inputTokens` | `number?` | `results.input_tokens` | Input / prompt tokens consumed |
| `outputTokens` | `number?` | `results.output_tokens` | Output / completion tokens consumed |
| `searchRequests` | `number?` | **—** | Number of search API calls (when tracked separately) |

An errored run carries `tokenUsage: {}`, so both ingested columns are `NULL`.

### `RawSearchCall`

Not ingested. `results.raw_ref` is a reserved, always-`NULL` hook for a future
lazy-load of raw payloads (DESIGN.md §4) — it does **not** point at these.

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `callIndex` | `number` | **—** | 0-based index of this search call within the run |
| `timestamp` | `string` | **—** | ISO-8601 time of capture |
| `queryText` | `string \| null` | **—** | Search query text (null when the provider doesn't expose it) |
| `rawInput` | `unknown` | **—** | Verbatim tool-call / request object from the provider |
| `rawOutput` | `unknown` | **—** | Verbatim tool-result / response object from the provider |

### `RunError`

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `code` | `string` | `results.error_code` | Error code |
| `message` | `string` | `results.error_message` | Human-readable error message |
| `retryable` | `boolean` | **—** | Whether the error is transient |
| `retriesAttempted` | `number` | **—** | Number of retries before giving up |

`results.has_error` is derived: `true` exactly when `error !== null`.

**An errored result has no verdict.** The judge never scores a failed call, so
there is no `analysis-*.jsonl` line for it and no `verdicts` row. Errored rows
are excluded from every cohort and every rate denominator
(`packages/db/src/metrics.ts`) — they are **not** counted as "brand not
mentioned". A `LEFT JOIN verdicts` that treats a missing verdict as a zero will
understate every rate.

---

## Analysis Verdict (`analysis-YYYY-MM-DD.jsonl`)

One line per **successful** (prompt x provider x model) result, produced by the
LLM judge. Defined in `packages/core/src/verdict.ts`. Ingested into `verdicts`
and its child tables.

A run's `analysis-*.jsonl` therefore has **fewer** lines than its
`results-*.jsonl` whenever any call failed.

### `ResultVerdict`

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `resultId` | `string` | `verdicts.result_id` (pk, fk → `results.id`) | UUID of the `UnifiedResult` that was judged |
| `prompt` | `string` | hashed into `verdicts.prompt_id` | The prompt text |
| `provider` | `string` | `verdicts.provider` | Provider key |
| `model` | `string` | `verdicts.model` | Model identifier |
| `promptCategory` | `string \| null` | **—** | Theme tag, repeated from the result. The dashboard reads the theme off `results.run_theme` instead |
| `brandMention` | `BrandMention` | see below | Was the brand mentioned in the response? |
| `descriptionAccuracy` | `DescriptionAccuracy \| null` | see below | How accurately the brand was described (null when not mentioned) |
| `ownedCitation` | `OwnedCitation` | see below | Was an owned domain linked in the response? |
| `competitivePosition` | `CompetitivePosition` | see below | Where the brand ranked vs. competitors |
| `mentionHypothesis` | `string \| null` | `verdicts.mention_hypothesis` | LLM-generated hypothesis explaining why the brand was or wasn't mentioned |
| `analyzedAt` | `string` | `verdicts.analyzed_at` | ISO-8601 time the verdict was produced. Also the dedupe key: re-judging a result within a run keeps the **latest** verdict |
| `judgeModel` | `string` | `verdicts.judge_model` | Model used as the LLM judge |
| `judgeTokens` | `JudgeTokens` | `verdicts.judge_input_tokens`, `judge_output_tokens` | Token usage for the judge call |

A verdict whose `resultId` has no matching result in the same run is **dropped**
at ingest and counted in `ingest_runs.orphan_verdict_count` (DESIGN.md §5).

### `BrandMention`

Whether the brand appeared by name (or alias) anywhere in the provider's
response text.

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `mentioned` | `boolean` | `verdicts.mentioned` | `true` if the brand name or any alias appeared in the response |
| `mentionCount` | `number` | `verdicts.mention_count` | Number of times the brand was mentioned |
| `excerpts` | `string[]` | `verdict_excerpts.excerpt`, one row each | Passages from the response containing the brand name |

`excerpts` is the field to check when a dashboard reports 0% mention rate. An
empty `verdict_excerpts` across a whole run means the matcher never fired, which
looks exactly like a brand that genuinely is not mentioned.

### `DescriptionAccuracy`

How faithfully the response described the brand, compared to
`brand.groundTruthDescription` in the config. Populated **exactly when**
`brandMention.mentioned` is true, and `null` otherwise — so
`accuracy_score IS NOT NULL` and `mentioned` are interchangeable filters.

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `score` | `1 \| 2 \| 3 \| 4 \| 5` | `verdicts.accuracy_score` | 1 = completely wrong, 5 = perfectly accurate |
| `reasoning` | `string` | `verdicts.accuracy_reasoning` | Judge's explanation of the score |

### `OwnedCitation`

Whether the response linked to any of the brand's owned domains (from
`brand.ownedDomains` in config). This is different from `BrandMention` — a
response can name-drop the brand without ever linking to its website, or cite a
URL without mentioning the brand by name.

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `cited` | `boolean` | `verdicts.owned_cited` | `true` if at least one owned-domain URL appeared in the response or its citations |
| `urls` | `string[]` | `verdict_owned_urls.url`, one row each | The owned-domain URLs that were found |

### `CompetitivePosition`

Where the brand ranked when competitors were also present in the response.

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `othersPresent` | `boolean` | `verdicts.others_present` | Were any competitors mentioned? |
| `othersCount` | `number` | `verdicts.others_count` | How many distinct competitors were mentioned |
| `brandRank` | `1 \| 2 \| 3 \| "not_ranked"` | `verdicts.brand_rank` | Brand's position: 1st, 2nd, 3rd recommended, or not ranked. **Stored as `text`** — the numbers round-trip as the strings `'1'`, `'2'`, `'3'`, so compare against strings, not integers |
| `competitors` | `CompetitorEntry[]` | `competitor_mentions`, `competitor_cited_urls` | Per-competitor breakdown |

### `CompetitorEntry`

The source array lists **every** configured competitor on every row, with
`mentioned` either way. Ingest stores **only the `mentioned: true` entries**, so
absence of a `competitor_mentions` row is how "not mentioned" is represented.

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `name` | `string` | `competitor_mentions.competitor_name` | Competitor name |
| `mentioned` | `boolean` | **—** (used as the filter) | Was this competitor mentioned? |
| `citedUrls` | `string[]` | `competitor_cited_urls.url` (+ `competitor_name`) | URLs cited for this competitor |

### `JudgeTokens`

| Field | Type | DB column | Description |
|-------|------|-----------|-------------|
| `input` | `number` | `verdicts.judge_input_tokens` | Input tokens consumed by the judge call |
| `output` | `number` | `verdicts.judge_output_tokens` | Output tokens produced by the judge call |

---

## Week Comparison (`comparison-YYYY-MM-DD.json`)

Computed by `bun run analyze` when a previous week's analysis exists. Defined in
`apps/pipeline/src/analytics/types.ts`.

**Never ingested.** The dashboard recomputes every week-over-week delta live in
SQL over current DB state, because an old run can be re-judged retroactively
(DESIGN.md §5). This file is for reading and for the learnings generators; there
is no table behind it.

### `WeekComparison`

| Field | Type | Description |
|-------|------|-------------|
| `currentDate` | `string` | Date of the current analysis |
| `previousDate` | `string` | Date of the previous analysis |
| `deltas` | `ResultDelta[]` | Per-result changes |
| `summary` | `WeekComparisonSummary` | Aggregate changes |

### `ResultDelta`

One entry per `(prompt, provider, model)` series that has a verdict in **both**
weeks. A series present in only one of the two weeks produces **no entry** —
`deltas` is the intersection, not the union.

This is the quiet one. When a provider fails a week, its results carry an error
and no verdict, so the week it recovers shows **zero** deltas for that provider:
the recovery is invisible in this file, not reported as a gain. Counting
`deltas` also undercounts the week. Use `deltas.length` as "series comparable
across both weeks", never as "results this week".

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | `string` | The prompt text |
| `provider` | `string` | Provider key |
| `model` | `string` | Model identifier |
| `newMention` | `boolean` | Brand was not mentioned last week but is now |
| `lostMention` | `boolean` | Brand was mentioned last week but isn't now |
| `prevAccuracy` | `number \| null` | Previous week's accuracy score (null when not mentioned) |
| `currAccuracy` | `number \| null` | Current week's accuracy score (null when not mentioned) |
| `accuracyDelta` | `number \| null` | Change in accuracy (null if either week lacks a score) |
| `gainedOwnedCitation` | `boolean` | Owned citation appeared this week but not last |
| `lostOwnedCitation` | `boolean` | Owned citation disappeared this week |
| `prevRank` | `BrandRank \| null` | Previous week's rank. Typed nullable, but **never null in practice** — an entry only exists when both weeks have the series |
| `currRank` | `BrandRank` | Current week's rank |
| `rankImproved` | `boolean` | Rank moved to a better (lower) position; `not_ranked` sorts as 4 |
| `newCompetitors` | `string[]` | Competitors mentioned this week but not last |
| `departedCompetitors` | `string[]` | Competitors mentioned last week but not this |
| `mentionHypothesis` | `string \| null` | Judge's hypothesis for the current week |

### `WeekComparisonSummary`

Every field here is computed over each week's **full verdict list**, not over
the matched series in `deltas`. Summary and deltas do not share a denominator,
and in a week where a provider failed they will not agree.

| Field | Type | Description |
|-------|------|-------------|
| `totalResults` | `number` | Verdicts in the **current** week. Not the number of comparisons — that is `deltas.length`, which is `<=` this |
| `mentionedCount` | `{ prev, curr }` | Number of verdicts with brand mentions, each week |
| `avgAccuracy` | `{ prev: number \| null, curr: number \| null }` | Mean accuracy score over that week's scored verdicts; null when the week has none |
| `ownedCitationCount` | `{ prev, curr }` | Number of verdicts with owned citations |
| `primaryRankCount` | `{ prev, curr }` | Number of verdicts where brand was ranked 1st |
| `competitorCounts` | `Record<string, { prev, curr }>` | Per-competitor mention counts; only `mentioned: true` entries are counted |

---

## Learning (`learnings/YYYY-MM-DD/<slug>.json`)

One JSON object per generator per run, written by `bun run learnings` into
`results/analysis/learnings/<date>/<slug>.json`. Defined in
`packages/core/src/learning.ts` and validated before writing by
`apps/pipeline/src/learnings/validate.ts`. Run-scoped and frozen once written.

**Not ingested.** There is no table behind it in v1.

### `Learning`

| Field | Type | Description |
|-------|------|-------------|
| `slug` | `string` | Stable catalog key, e.g. `movers`. One file per slug per run |
| `tier` | `"structured" \| "agentic"` | Which generator tier produced it |
| `runDate` | `string` | The run this learning interprets, `YYYY-MM-DD` |
| `status` | `"ok" \| "nothing_notable" \| "unavailable"` | `ok` = a real finding; `nothing_notable` = ran, found nothing worth surfacing; `unavailable` = failed or timed out, slot degrades rather than failing the run |
| `headline` | `string` | One-line finding |
| `body` | `string` | The interpretation |
| `evidence` | `LearningEvidence[]` | Cited data backing the finding. **Non-empty is enforced when `status` is `ok`** |
| `confidence` | `"low" \| "medium" \| "high"` | How much weight to put on the finding |
| `generator` | `string` | Model / version provenance, e.g. `movers@openai:gpt-5.2` |
| `generatedAt` | `string` | ISO timestamp the record was produced |

### `LearningEvidence`

| Field | Type | Description |
|-------|------|-------------|
| `label` | `string` | What the datum is |
| `value` | `string \| number` | Raw scalar from the source, kept verbatim so the reader re-derives nothing |
| `delta` | `string \| number?` | Change versus the previous run, when the datum has one |
| `source` | `string` | Where the datum came from, e.g. `comparison-2026-06-22.json` |
