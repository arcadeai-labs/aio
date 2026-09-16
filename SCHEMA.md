# Data Schemas

Field-level reference for every JSON object produced by the pipeline.

---

## Result (`results-YYYY-MM-DD.jsonl`)

One line per (prompt x provider) run. Defined in `packages/core/src/unified-result.ts`.

### `UnifiedResult`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | UUID for this result |
| `prompt` | `string` | The question sent to the provider |
| `promptCategory` | `string?` | Category tag from the prompts CSV |
| `promptMeta` | `Record<string, string>?` | Any extra columns from the prompts CSV |
| `searchQueries` | `SearchQuery[]` | Queries the provider issued to its search backend |
| `searchResults` | `SearchResult[]` | Web pages returned by the search step |
| `responseText` | `string` | The provider's final answer text |
| `citations` | `Citation[]` | URLs the provider explicitly cited in its answer |
| `metadata` | `RunMetadata` | Timing, cost, model info |
| `rawSearchCalls` | `RawSearchCall[]?` | Verbatim API objects from each search invocation |
| `error` | `RunError \| null` | Error details if the call failed, otherwise null |

### `SearchQuery`

| Field | Type | Description |
|-------|------|-------------|
| `query` | `string` | The search query string |
| `timestamp` | `string` | ISO-8601 time the query was issued |

### `SearchResult`

| Field | Type | Description |
|-------|------|-------------|
| `url` | `string` | URL of the search result |
| `title` | `string` | Page title |
| `snippet` | `string` | Snippet / summary text |
| `score` | `number?` | Relevance score (when the provider returns one) |
| `pageDate` | `string?` | Publication date of the page (when available) |

### `Citation`

| Field | Type | Description |
|-------|------|-------------|
| `url` | `string` | Cited URL |
| `title` | `string` | Title of the cited page |
| `citedText` | `string` | The passage from the response that references this URL |
| `startIndex` | `number?` | Character offset where the citation starts in `responseText` |
| `endIndex` | `number?` | Character offset where the citation ends in `responseText` |

### `RunMetadata`

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `string` | Provider key (openai, anthropic, perplexity, etc.) |
| `model` | `string` | Model identifier used for the run |
| `searchTool` | `string` | Name of the search tool / method |
| `startedAt` | `string` | ISO-8601 start time |
| `completedAt` | `string` | ISO-8601 completion time |
| `latencyMs` | `number` | Wall-clock time in milliseconds |
| `tokenUsage` | `TokenUsage` | Token counts for the run |
| `estimatedCostUsd` | `number?` | Estimated API cost in USD |
| `runId` | `string` | UUID for the overall run batch |
| `providerMeta` | `Record<string, unknown>?` | Provider-specific metadata |

### `TokenUsage`

| Field | Type | Description |
|-------|------|-------------|
| `inputTokens` | `number?` | Input / prompt tokens consumed |
| `outputTokens` | `number?` | Output / completion tokens consumed |
| `searchRequests` | `number?` | Number of search API calls (when tracked separately) |

### `RawSearchCall`

| Field | Type | Description |
|-------|------|-------------|
| `callIndex` | `number` | 0-based index of this search call within the run |
| `timestamp` | `string` | ISO-8601 time of capture |
| `queryText` | `string \| null` | Search query text (null when the provider doesn't expose it) |
| `rawInput` | `unknown` | Verbatim tool-call / request object from the provider |
| `rawOutput` | `unknown` | Verbatim tool-result / response object from the provider |

### `RunError`

| Field | Type | Description |
|-------|------|-------------|
| `code` | `string` | Error code |
| `message` | `string` | Human-readable error message |
| `retryable` | `boolean` | Whether the error is transient |
| `retriesAttempted` | `number` | Number of retries before giving up |

---

## Analysis Verdict (`analysis-YYYY-MM-DD.jsonl`)

One line per (prompt x provider) result, produced by the LLM judge. Defined in `packages/core/src/verdict.ts`.

### `ResultVerdict`

| Field | Type | Description |
|-------|------|-------------|
| `resultId` | `string` | UUID of the `UnifiedResult` that was judged |
| `prompt` | `string` | The prompt text |
| `provider` | `string` | Provider key |
| `model` | `string` | Model identifier |
| `promptCategory` | `string \| null` | Category tag |
| `brandMention` | `BrandMention` | Was the brand mentioned in the response? |
| `descriptionAccuracy` | `DescriptionAccuracy \| null` | How accurately the brand was described (null when not mentioned) |
| `ownedCitation` | `OwnedCitation` | Was an owned domain linked in the response? |
| `competitivePosition` | `CompetitivePosition` | Where the brand ranked vs. competitors |
| `mentionHypothesis` | `string \| null` | LLM-generated hypothesis explaining why the brand was or wasn't mentioned |
| `analyzedAt` | `string` | ISO-8601 time the verdict was produced |
| `judgeModel` | `string` | Model used as the LLM judge |
| `judgeTokens` | `JudgeTokens` | Token usage for the judge call |

### `BrandMention`

Whether the brand appeared by name (or alias) anywhere in the provider's response text.

| Field | Type | Description |
|-------|------|-------------|
| `mentioned` | `boolean` | `true` if the brand name or any alias appeared in the response |
| `mentionCount` | `number` | Number of times the brand was mentioned |
| `excerpts` | `string[]` | Passages from the response containing the brand name |

### `DescriptionAccuracy`

How faithfully the response described the brand, compared to `brand.groundTruthDescription` in the config. Only populated when the brand was mentioned.

| Field | Type | Description |
|-------|------|-------------|
| `score` | `1 \| 2 \| 3 \| 4 \| 5` | 1 = completely wrong, 5 = perfectly accurate |
| `reasoning` | `string` | Judge's explanation of the score |

### `OwnedCitation`

Whether the response linked to any of the brand's owned domains (from `brand.ownedDomains` in config). This is different from `BrandMention` — a response can name-drop the brand without ever linking to its website, or cite a URL without mentioning the brand by name.

| Field | Type | Description |
|-------|------|-------------|
| `cited` | `boolean` | `true` if at least one owned-domain URL appeared in the response or its citations |
| `urls` | `string[]` | The owned-domain URLs that were found |

### `CompetitivePosition`

Where the brand ranked when competitors were also present in the response.

| Field | Type | Description |
|-------|------|-------------|
| `othersPresent` | `boolean` | Were any competitors mentioned? |
| `othersCount` | `number` | How many distinct competitors were mentioned |
| `brandRank` | `1 \| 2 \| 3 \| "not_ranked"` | Brand's position: 1st, 2nd, 3rd recommended, or not ranked |
| `competitors` | `CompetitorEntry[]` | Per-competitor breakdown |

### `CompetitorEntry`

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Competitor name |
| `mentioned` | `boolean` | Was this competitor mentioned? |
| `citedUrls` | `string[]` | URLs cited for this competitor |

### `JudgeTokens`

| Field | Type | Description |
|-------|------|-------------|
| `input` | `number` | Input tokens consumed by the judge call |
| `output` | `number` | Output tokens produced by the judge call |

---

## Week Comparison (`comparison-YYYY-MM-DD.json`)

Computed when a previous week's analysis exists. Tracks what changed between two consecutive analysis runs.

### `WeekComparison`

| Field | Type | Description |
|-------|------|-------------|
| `currentDate` | `string` | Date of the current analysis |
| `previousDate` | `string` | Date of the previous analysis |
| `deltas` | `ResultDelta[]` | Per-result changes |
| `summary` | `WeekComparisonSummary` | Aggregate changes |

### `ResultDelta`

One entry per (prompt x provider x model) pair that exists in either week.

| Field | Type | Description |
|-------|------|-------------|
| `prompt` | `string` | The prompt text |
| `provider` | `string` | Provider key |
| `model` | `string` | Model identifier |
| `newMention` | `boolean` | Brand was not mentioned last week but is now |
| `lostMention` | `boolean` | Brand was mentioned last week but isn't now |
| `prevAccuracy` | `number \| null` | Previous week's accuracy score |
| `currAccuracy` | `number \| null` | Current week's accuracy score |
| `accuracyDelta` | `number \| null` | Change in accuracy (null if either week lacks a score) |
| `gainedOwnedCitation` | `boolean` | Owned citation appeared this week but not last |
| `lostOwnedCitation` | `boolean` | Owned citation disappeared this week |
| `prevRank` | `BrandRank \| null` | Previous week's rank |
| `currRank` | `BrandRank` | Current week's rank |
| `rankImproved` | `boolean` | Rank moved to a better (lower) position |
| `newCompetitors` | `string[]` | Competitors mentioned this week but not last |
| `departedCompetitors` | `string[]` | Competitors mentioned last week but not this |
| `mentionHypothesis` | `string \| null` | Judge's hypothesis for the current week |

### `WeekComparisonSummary`

| Field | Type | Description |
|-------|------|-------------|
| `totalResults` | `number` | Total results compared |
| `mentionedCount` | `{ prev, curr }` | Number of results with brand mentions, each week |
| `avgAccuracy` | `{ prev, curr }` | Average accuracy score (null if no mentions) |
| `ownedCitationCount` | `{ prev, curr }` | Number of results with owned citations |
| `primaryRankCount` | `{ prev, curr }` | Number of results where brand was ranked 1st |
| `competitorCounts` | `Record<string, { prev, curr }>` | Per-competitor mention counts |
