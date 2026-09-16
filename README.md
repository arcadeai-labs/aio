# aio

Track how AI search engines describe your brand, week over week.

`aio` runs a set of prompts against several LLM + web-search combinations,
captures every answer in one unified format, scores each one with an LLM judge
(is the brand mentioned? described accurately? cited? ranked against
competitors?), and serves the trend on a local dashboard.

It is built to be forked. Point it at your own brand and prompts and it becomes
your tracker; nothing in here is specific to the project it grew out of.

## Quickstart

Requires [Bun](https://bun.sh) and Docker (Docker Desktop, OrbStack, Colima —
any of them).

```bash
git clone https://github.com/arcadeai-labs/aio.git && cd aio
docker compose up --build
```

That starts Postgres, applies migrations, and serves the dashboard on
<http://localhost:3000>. It will be empty — there is no data until you run the
pipeline — but every page renders, and there is no sign-in to get past.

To fill it:

```bash
bun install
cp .env.example .env                              # add at least one provider key
cp analytics.config.demo.json analytics.config.json

bun run start      # ask every provider every prompt  -> results/results-<date>.jsonl
bun run analyze    # judge each answer                -> results/analysis/
bun run ingest     # load into Postgres              -> dashboard lights up
```

`analytics.config.demo.json` tracks Todoist, a real and widely-written-about
product, so the first run returns genuine mentions and rankings. When you are
ready to track your own brand, start from `analytics.config.example.json`
instead and edit it.

## How it fits together

```
prompts/*.csv ──▶ pipeline ──▶ results/*.jsonl ──▶ analyze ──▶ results/analysis/*.jsonl
                                                                        │
                                                                     ingest
                                                                        ▼
                                                                    Postgres ──▶ dashboard
```

The pipeline and the judge run on your machine and write JSONL files. The
dashboard never reads those files: `bun run ingest` reconciles them into
Postgres, and the web app only ever queries the database. JSONL stays the
archival record, so you can re-ingest, re-judge, or change the schema without
re-paying for a run.

## Providers

| Provider | SDK | Search method |
|----------|-----|---------------|
| **OpenAI** | `openai` | Responses API + `web_search_preview` |
| **Anthropic** | `@anthropic-ai/sdk` | Messages API + `web_search_20250305` |
| **Anthropic Agent** | `@anthropic-ai/claude-agent-sdk` | Agent SDK + built-in `WebSearch` tool |
| **OpenRouter** | `openai` (custom baseURL) | `:online` model suffix |
| **Perplexity** | `openai` (custom baseURL) | Sonar models with citations |
| **Exa** | `exa-js` + `openai` | Exa search + LLM synthesis |
| **Codex** | `@openai/codex-sdk` | Codex agent with live web search |

A provider whose key is missing fails gracefully — the rest of the run still
completes. `OPENAI_API_KEY` is used by OpenAI, Exa (for synthesis), Codex, and
the analytics judge. `ANTHROPIC_API_KEY` covers both Anthropic providers.

### Reading the run summary

Every run ends with a per-target block and exits non-zero when a target that
could have worked returned nothing:

```
────────────────────────────────────────────────────────────────────────
RUN SUMMARY
────────────────────────────────────────────────────────────────────────
  OK             openai/gpt-5.6-terra           16/16 ok
  FAILED         anthropic/claude-sonnet-5       0/16 ok      HTTP_404×16
  NO CREDENTIALS perplexity/sonar-pro            0/16 ok      HTTP_401×16
────────────────────────────────────────────────────────────────────────
```

The distinction matters. **NO CREDENTIALS** is a provider you have not
configured; the run still exits 0, because the rest of it is valid. **FAILED**
is a provider that answered with an error — a retired model id, a removed
endpoint, an outage — and exits 1.

Errored rows are written but excluded from every downstream denominator, so a
run that quietly lost a provider still moves the dashboard, for reasons that
have nothing to do with your brand. Do not `bun run analyze` or `bun run ingest`
on a run that exited 1 until you know why.

## Prompts

Edit `prompts/default.csv`:

```csv
prompt,category,topic,brandedType
"What is Taskwell and who is it for?",Brand Understanding,Product Overview,Branded
"What is the best to-do list app in 2026?",Discovery & Recommendation,Recommendation,Unbranded
```

| Column | Required | Description |
|--------|----------|-------------|
| `prompt` | Yes | The question sent to each provider |
| `category` | No | Tag for grouping results |
| Any extra columns | No | Preserved as `promptMeta` on each result |

The `brandedType` split is the one worth keeping. **Branded** prompts name your
brand and measure whether models describe it correctly. **Unbranded** prompts
never mention it and measure whether you get recommended at all. They answer
different questions, and averaging them together hides both.

A `Relevant` column, if present, filters rows out when set to `FALSE`.

## Targets

By default every provider runs with a preset model, pinned in
`apps/pipeline/src/targets.ts`. Those pins go stale — model ids get superseded
and eventually retired — so treat them as something to re-check, not as
something that maintains itself. To customize, write a JSON file and pass
`TARGETS_FILE`:

```json
[
  { "provider": "anthropic", "model": "claude-sonnet-5" },
  { "provider": "perplexity", "model": "sonar-pro" },
  {
    "provider": "exa",
    "model": "exa-auto",
    "options": { "synthesisProvider": "openai", "synthesisModel": "gpt-5.6-luna" }
  }
]
```

```bash
TARGETS_FILE=targets.json bun run start
```

Changing a model id starts a **new** week-over-week series: comparison matches
on `(prompt, provider, model)`, so the old series ends silently and the new one
begins with no history. That is the correct behaviour — a different model is a
different measurement — but expect a gap in the trend on the run after a bump.

## Analytics

An LLM-as-judge pipeline scores each result for brand presence, description
accuracy, owned-domain citations, and competitive positioning, then compares
week over week.

Configure it in `analytics.config.json`:

| Field | Description |
|-------|-------------|
| `brand.name` | Primary brand name to search for |
| `brand.aliases` | Alternate names (also checked during pre-filter) |
| `brand.ownedDomains` | Domains to check in citations |
| `brand.groundTruthDescription` | How the brand *should* be described (scores accuracy 1-5) |
| `brand.knownCompetitors` | Competitors to track in responses |
| `judgeModel` | LLM used for judging |
| `concurrency` | Max concurrent judge calls |
| `resultsDir` / `outputDir` | Where results are read from and analysis written to |
| `googleSheet` | Optional; omit entirely to skip the spreadsheet export |

```bash
bun run analyze                                  # today's results
ANALYSIS_DATE=2026-02-22 bun run analyze         # a specific date
ANALYTICS_CONFIG=custom.json bun run analyze     # a different config

# Resume a run that died partway through — reuses verdicts already in
# analysis-DATE.jsonl and judges only what is missing.
ANALYSIS_DATE=2026-08-25 bun run analyze --resume

# Resume, but discard leftovers from an earlier run so the week is judged by a
# single run (verdicts older than the cutoff are re-judged).
ANALYSIS_DATE=2026-08-25 bun run analyze --resume --rejudge-before=2026-08-27T00:00:00Z
```

Verdicts are appended as they are judged, so a crash never loses completed
work. Without `--resume`, an existing `analysis-DATE.jsonl` is rotated to
`.jsonl.bak` first, so a re-run can never interleave with a previous run's
verdicts.

**Phase 1 — judge.** Each result is scored for brand mention (boolean + count +
excerpts), description accuracy (1-5 with reasoning), owned-domain citations,
and competitive positioning (rank + competitor list). A regex pre-filter skips
the full call when the brand appears nowhere in the response or citations,
sending a shorter competitive-only prompt instead.

**Phase 2 — comparison.** Verdicts are matched across weeks by
`(prompt, provider, model)`. Deltas cover mentions gained/lost, accuracy shifts,
citation changes, rank movement, and competitor turnover.

Output lands in `results/analysis/`: one `ResultVerdict` per line in
`analysis-YYYY-MM-DD.jsonl`, a `comparison-YYYY-MM-DD.json`, a markdown
`summary-YYYY-MM-DD.md`, and `tracker-{detail,summary}.csv` with all weeks side
by side. See [SCHEMA.md](SCHEMA.md) for every field.

## Dashboard

```bash
docker compose up          # http://localhost:3000
```

Five views: **Scoreboard** (headline metrics and per-provider coverage),
**Prompts** (per-prompt trajectory over time), **Competitive** (share of voice),
**Cited** (which of your URLs get cited), and **Runs** (what has been ingested).

### Access control

**Off by default.** With `ALLOWED_EMAIL_DOMAINS` unset there is no sign-in and
the dashboard is open to anyone who can reach it. That is the right default on
localhost and the wrong one anywhere else.

To require Google sign-in, set all of these (see `.env.example`):

```
ALLOWED_EMAIL_DOMAINS=example.com,partner.dev
BETTER_AUTH_SECRET=<openssl rand -base64 32>
BETTER_AUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

Only verified Google accounts on those exact domains get in. Subdomains and
look-alikes (`evil.example.com`, `example.com.evil.com`, `notexample.com`) are
rejected — see `packages/core/test/auth-gate.test.ts`.

## Querying the raw results

```bash
# All responses from one provider
cat results/results-*.jsonl | jq 'select(.metadata.provider == "anthropic")'

# Response lengths across providers
cat results/results-*.jsonl | jq '{provider: .metadata.provider, prompt: .prompt[:50], len: (.responseText | length)}'

# Errors
cat results/results-*.jsonl | jq 'select(.error != null) | {provider: .metadata.provider, error: .error.message}'

# Raw search output for one provider
cat results/results-*.jsonl | jq 'select(.metadata.provider == "anthropic") | .rawSearchCalls[0].rawOutput'
```

## Scheduling

`.github/workflows/weekly-run.yml` runs the pipeline every Monday at 09:00 UTC
and uploads results as build artifacts. It is opt-in: it does nothing useful
until you add your provider keys as repository secrets.

## Development

```bash
bun install
bun run typecheck
bun run lint
bun test
```

The DB-backed suite in `packages/ingest/test/reconcile.test.ts` **skips** when no
Postgres is reachable, and a skip is not a pass. Run `docker compose up -d db`
before trusting a green run of that file.

Agent orchestration for this repo lives in [`.orca/`](.orca/README.md).
