---
name: aio-learnings
description: Analyze this repo's AI brand-presence tracker results and produce a trend summary with branded/unbranded splits
disable-model-invocation: true
allowed-tools: Bash Read Glob Grep
---

# Brand Presence Trend Analysis

You are analyzing results from this repo's weekly AI brand-presence tracker.

## Read the brand from config first

**Do not assume which brand this is.** Read `analytics.config.json` (or the file
named by `ANALYTICS_CONFIG`) before anything else and take `brand.name`,
`brand.aliases`, `brand.ownedDomains`, `brand.groundTruthDescription` and
`brand.knownCompetitors` from there. Everything below refers to "the brand",
meaning whatever that config says.

If the config is missing, stop and say so rather than guessing from the data —
a wrong brand name produces a confident report about nothing.

## Where the data lives

Results live under the directory named by `resultsDir` in the config
(`results/` by default), with an `analysis/` subdirectory. The key files are:

- `summary-<date>.md` — full report for a single run (overview metrics, provider breakdown, category breakdown, competitive landscape, week-over-week delta, notable results)
- `comparison-<date>.json` — structured week-over-week delta with per-prompt deltas and a summary object
- `analysis-<date>.jsonl` — one JSON object per result with verdict fields (brandMention, descriptionAccuracy, ownedCitation, competitivePosition, etc.)
- `results-<date>.jsonl` — raw results with prompt metadata including branded/unbranded classification

### Branded vs Unbranded split

Raw result records in `results/results-*.jsonl` have a `promptMeta.brandedType` field — either `"Branded"` (prompt names the brand) or `"Unbranded"` (generic query). This field is NOT in the analysis JSONL, but records join on `resultId` (analysis) = `id` (raw). The type is consistent per prompt across all providers.

- **Branded** prompts measure: accuracy of description, whether LLMs know what the brand is, competitive positioning when the brand is the subject
- **Unbranded** prompts measure: organic discoverability, whether LLMs recommend the brand unprompted, share of voice vs competitors

Never average the two together. They answer different questions, and a combined
number hides both: a brand can be described perfectly whenever it is named and
never surface once when it is not.

### Schema of key fields

Analysis records (`analysis-*.jsonl`):
```json
{
  "resultId": "uuid",
  "prompt": "string",
  "provider": "string",
  "model": "string",
  "promptCategory": "string",
  "brandMention": { "mentioned": bool, "mentionCount": int, "excerpts": [] },
  "descriptionAccuracy": { "score": 1-5, "reasoning": "string" } | null,
  "ownedCitation": { "cited": bool, "urls": [] },
  "competitivePosition": { "othersPresent": bool, "othersCount": int, "brandRank": 1|2|3|"not_ranked", "competitors": [] }
}
```

Raw result records (`results-*.jsonl`):
```json
{
  "id": "uuid",
  "prompt": "string",
  "promptCategory": "string",
  "promptMeta": { "labels": "string", "brandedType": "Branded"|"Unbranded" },
  "provider": "string",
  "model": "string"
}
```

## What to do

1. First, list all available summary and analysis files across both directories to understand what runs exist.

2. Read the **two most recent** summary markdown files from `results/analysis/` (the large runs). Also read the most recent comparison JSON if available.

3. For each of the two most recent large runs, compute branded vs unbranded metrics by joining the analysis JSONL with the raw results JSONL on `resultId` = `id`. Use python to do the join and aggregation. For each segment compute:
   - Total results and mention count/rate
   - Average accuracy (only where mentioned)
   - Owned citation count/rate
   - #1 rank count/rate (brandRank === 1)
   - Breakdown by provider
   - Breakdown by promptCategory
   - Top competitors by mention count

4. Produce the report in three sections — **Global**, **Branded**, and **Unbranded** — each containing:

   a. **Headline metrics table** — one row per run date, columns: results count, mention rate, avg accuracy (where mentioned), citation rate, #1 rank rate

   b. **Trend narrative** — what's improving, declining, or flat across runs

   c. **Provider breakdown** — strongest/weakest providers for the brand, and how that's shifting

   d. **Category breakdown** — where the brand shows up most/least

   e. **Competitive landscape** — top 5 competitors by mention count, gaining or losing ground vs the brand

   f. **Persistent problems** — recurring accuracy issues (e.g., brand confusion with similarly-named products), dead-zone categories

5. Add a final **Cross-cut insights** section:
   - How does mention rate differ between branded and unbranded? Is the gap narrowing?
   - Which categories or providers show the biggest branded-vs-unbranded divergence?
   - Are there unbranded prompts where the brand is consistently missing but competitors appear?

6. Optionally, if runs from an older prompt set exist in a separate results directory, include them in the global headline table for historical context. Runs that predate the branded/unbranded split can only appear in the global section — do not infer a split that was never recorded.

Keep it concise — focus on actionable insights and trends, not reproducing full reports.
