# aio — Design record

The authoritative architecture document for this repo: what the system is, the
contracts between its parts, and the reasoning behind each decision. Sections
1-12 describe the dashboard, which is the largest piece; §13 covers the fork-out
of the project into a standalone template.

This is the document agents working on this repo are told to read and not
deviate from. It may be edited to **record** decisions already made. Anything
with meaningful architectural impact gates with a human first.

A read-only web dashboard for navigating weekly AI brand-presence data
interactively. It replaces ad-hoc JSONL spelunking and spreadsheet exports with
a fast, cohort-aware analytics surface.

---

## 1. Goals & non-goals

**Goals**

- Make the **weekly view the centerpiece**: see the latest run's standing at a
  glance, step back through prior runs, and read every part of any prompt /
  response / judge verdict.
- First-class **cohort transparency** — every number is labeled with the cohort
  and denominator it was computed over.
- First-class **segments** (global / branded / unbranded) and **themes**, with
  the ability to inspect theme performance *within* a segment.
- First-class **prompt trajectories** over time.
- A design that reads as a serious instrument, not a generated app.
- Live in this monorepo; reuse the pipeline's data with a clean ingest boundary.

**Non-goals (v1)**

- No write features in the UI (read-only). Config/owned-URL **editing** and the
  retroactive **re-analysis** that would follow are pipeline concerns for a
  later session.
- No inspection of verbatim provider API payloads (`rawSearchCalls`); those stay
  in the JSONL archive.
- No light theme.
- No public access control beyond an optional email-domain gate.

---

## 2. Scope of data

- **One prompt set at a time.** The dashboard assumes a stable prompt set
  carrying the `branded_type` and theme classification everything is built
  around. Changing the prompt set mid-stream breaks week-over-week matching,
  which joins on `(prompt, provider, model)`.
- Runs from an older regime with a different prompt shape are out of scope. The
  `ingest` package may gain a "legacy" backfill mode later; it is not built.

**Data volume reality.** A run is `prompts × providers` rows — a few hundred to
a few thousand. Over a year of weekly runs that is tens of thousands of result
rows plus matching verdicts and child rows. This is tiny: no partitioning,
sub-millisecond aggregates, and all week-over-week math computed live in SQL.
Any design here that assumes scale is solving a problem this project does not
have.

---

## 3. Architecture overview

| Concern | Decision |
|---|---|
| Database | **Postgres** (local, via `docker compose`) |
| App + DB hosting | **`docker compose`** — Postgres, a one-shot migrate service, and the web app on one local network |
| Runtime | **Bun** |
| Framework | **TanStack Start** (React, Vite) — server functions/loaders for auth-gated server-side queries |
| Data tables / charts | TanStack Table + Query; **visx** charts themed from scratch |
| ORM / schema source of truth | **Drizzle** (`packages/db`), migrations via `drizzle-kit` |
| Auth | **Optional.** Off unless `ALLOWED_EMAIL_DOMAINS` is set; then better-auth + Google OAuth with a server-side domain + `email_verified` check, sessions in Postgres |
| Ingestion | **Laptop-driven CLI** (`packages/ingest`) → Postgres on the published port |
| Design | Dark-only, Fey-inspired (see §9) |

### Monorepo layout (Bun workspaces)

```
aio-tool/
  apps/
    pipeline/      ← today's src/ (runner, providers, analytics, CLI commands)
    web/           ← TanStack Start dashboard
  packages/
    core/          ← shared TS types + zod schemas (result, verdict, config)
    db/            ← Drizzle schema, migrations, typed query layer (source of truth)
    ingest/        ← JSONL + config → Postgres reconciler (CLI, run from laptop)
  prompts/  results/  _results/   ← data archives (gitignored, unchanged)
```

- `packages/db` owns the schema; both `web` (reads) and `ingest` (writes) import it.
- `ingest` is its own package so the dashboard's data contract is decoupled from
  how runs are produced — historical JSONL can be re-ingested without touching
  the runner.
- Moving `src/` → `apps/pipeline/` is mechanical churn (import paths, scripts,
  `.claude` config) but isolated to that move.

---

## 4. Data model

Normalized, structured fields only. Verbatim raw blobs are **not** ingested; a
nullable `raw_ref` hook is reserved for a future lazy-load of raw payloads.

### Dimensions (cross-week, upserted — never deleted by a week replace)

- **`prompts`** — identity `prompt_id = hash(normalized_text)` where
  normalization = trim + collapse internal whitespace + lowercase. A reworded
  prompt is intentionally a *new* prompt.
  - `prompt_id` (pk), `text`, `normalized_text`, `theme` (latest-seen),
    `branded_type` (latest-seen: `branded|unbranded`), `is_relevant`,
    `location`, `first_seen_run`, `last_seen_run`.
  - Classification drift: per-run facts live on the result row; the dimension
    holds **latest-seen** for default grouping. Drift is flagged, not silently
    overwritten.
- **`prompt_labels`** — `prompt_id`, `label`. Parsed from the comma-joined
  `promptMeta.labels` at ingest. **Modeled but not surfaced in v1.**

### Facts (per-run, wholesale-replaced on re-ingest of that run)

- **`results`** — `id` (source UUID, pk), `run_date`, `prompt_id` (fk),
  `provider`, `model`, `response_text`, `search_tool`, `started_at`,
  `completed_at`, `latency_ms`, `input_tokens`, `output_tokens`,
  `estimated_cost_usd`, `error_code` (nullable), `error_message`,
  `has_error` (bool), **`run_branded_type`**, **`run_theme`** (the as-run facts),
  `raw_ref` (nullable, reserved).
- **`search_queries`** — `result_id` (fk), `query`, `ts`.
- **`search_results`** — `result_id` (fk), `url`, `title`, `snippet`, `score`,
  `page_date`.
- **`citations`** — `result_id` (fk), `url`, `title`, `cited_text`,
  `start_index`, `end_index`.
- **`verdicts`** — `result_id` (pk/fk), `prompt_id`, `provider`, `model`,
  `mentioned` (bool), `mention_count`, `accuracy_score` (1–5, nullable),
  `accuracy_reasoning`, `owned_cited` (bool), `others_present` (bool),
  `others_count`, `brand_rank` (`1|2|3|not_ranked`), `mention_hypothesis`,
  `analyzed_at`, `judge_model`, `judge_input_tokens`, `judge_output_tokens`.
- **`verdict_excerpts`** — `result_id` (fk), `excerpt` (brand-mention passages).
- **`verdict_owned_urls`** — `result_id` (fk), `url`.
- **`competitor_mentions`** — `result_id` (fk), `competitor_name`. **Only
  `mentioned=true` rows are stored** (the source enum lists every competitor on
  every row).
- **`competitor_cited_urls`** — `result_id` (fk), `competitor_name`, `url`.

### Config (per-run snapshots; file→DB import-only in v1)

- **`config_snapshots`** — `run_date`, `brand_name`, `ground_truth_description`,
  `judge_provider`, `judge_model`, `raw` (jsonb), `captured_at`. Captures what
  each analysis run considered, so historical cohorts stay accurate when the
  competitor/owned-URL set grows over time.
- **`config_owned_domains`** — `snapshot_id` (fk), `domain`, `active`,
  `added_at`, `removed_at`.
- **`config_competitors`** — `snapshot_id` (fk), `name`, `active`, …
- **`config_aliases`** — `snapshot_id` (fk), `alias`.
- These are relational (not a JSON blob) specifically to unblock a **future**
  `bun run config:export` (DB → `analytics.config.json`) when the DB becomes
  authoritative. No editor/exporter in v1.

### Provenance & auth

- **`ingest_runs`** — `id`, `run_date`, `results_file_hash`,
  `analysis_file_hash`, `result_count`, `verdict_count`, `status`, `ingested_at`.
  Powers per-run freshness in the UI and drives reconciliation (§5).
- **better-auth tables** — `user`, `session`, `account`, `verification` (in the
  same Postgres).

### Indexing notes

- `results(run_date, provider)`, `results(prompt_id)`, `verdicts(result_id)`,
  `competitor_mentions(result_id)`, `competitor_mentions(competitor_name)`.
- Aggregates join `results ⋈ verdicts` live; a convenience SQL view
  (`result_facts`) flattens the common columns. No materialized views needed at
  this volume.

---

## 5. Ingestion contract

`packages/ingest`, run from the laptop against the compose Postgres. The
pipeline run already happens locally; raw JSONL never leaves the machine.

- **Unit = one dated run (a "week").** `bun run ingest --week 2026-05-11` is
  **authoritative and idempotent**: in a single transaction it **wholesale-
  replaces** that run — delete the run's results/verdicts/children, re-insert
  from source. With 3,198 rows this is trivial and automatically **nukes
  superseded analysis** (no diffing, no orphans). Dimensions and config tables
  upsert (never deleted by a run replace).
- **Corpus reconciliation.** `bun run ingest` (no args) scans every
  `results-*.jsonl` / `analysis-*.jsonl`, hashes each run's source, compares to
  its `ingest_runs` record, and **re-ingests any run that is new or whose hash
  changed — current *or* historical**. Unchanged runs are skipped. This makes
  "the pipeline re-judged an old week last night" a no-op to reason about: run
  ingest, it rebuilds only what moved.
- **Source files only:** canonical `results-DATE.jsonl` + `analysis-DATE.jsonl`.
  **`.bak` files are ignored** and never reach the DB.
- **Load-time hygiene:** dedupe analysis by `resultId` (keep latest
  `analyzed_at`); filter competitor enum to `mentioned=true`; skip + flag any
  verdict whose `resultId` has no matching result.
- **Provenance:** every ingest writes an `ingest_runs` row (hashes, counts,
  status, timestamp) → surfaced as per-run **freshness** in the UI and used to
  detect partial/missing runs.

The dashboard **never** ingests the pipeline's `comparison-*.json`. All
week-over-week deltas and trajectories are computed **live in SQL** over current
DB state — the only correct option given old runs can change retroactively.

---

## 6. Dimensions, segments & cohorts

### Segment selector (primary control) — `branded_type`

`Global · Branded · Unbranded`. Sourced from `promptMeta.brandedType`.

### Theme (orthogonal facet) — from `promptCategory`

e.g. "Alternatives & Vendor Comparison", "Agent Authorization". Themes are a
filter/breakdown that composes with the segment, so theme performance can be
inspected **within** any segment (segment × theme cross-tab).

> Naming note: the source field literally named `promptCategory` holds the
> **theme**. The schema uses the canonical names `theme` / `branded_type` to
> avoid this trap.

**Corrected 2026-09-16 (driver, issue #11).** This section previously said the
theme came from the CSV `topic` column and that the CSV `category` column held
`branded_type`. Both were wrong for the shipped prompt set, and a forker writing
queries from that description would have filtered on the wrong field.

`apps/pipeline/src/load.ts` supports **two CSV dialects**, and resolves the theme
as `theme_name || category`:

| | legacy dialect | shipped `prompts/default.csv` |
|---|---|---|
| columns | `prompt, category, theme_name, …` | `prompt, category, topic, brandedType` |
| theme (`promptCategory`) | `theme_name` | **`category`** |
| `branded_type` | `category`, moved to `promptMeta.brandedType` | `brandedType`, carried through as meta |
| `topic` | — | a sub-topic, **not** the theme; survives in `promptMeta` |

So with the shipped CSV, a row of `category="Brand Understanding",
topic="Product Overview", brandedType="Branded"` ingests as
`theme = "Brand Understanding"`, `branded_type = "branded"` — confirmed against a
real ingested row.

The old description matched the legacy dialect, where `category` really did hold
branded_type. It was not updated when the shipped prompt set moved to explicit
`topic` and `brandedType` columns. **The code is authoritative here**; `SCHEMA.md`
documents the resolved behaviour.

### Cohorts (always labeled; never a bare number)

An explicit, always-visible funnel:

```
All (error IS NULL)
  └─ Mentioned (brandMention.mentioned)
       └─ Competitive (othersPresent = true)   ← rank / share-of-voice live here
  └─ Cited (ownedCitation.cited)               ← parallel high-value cohort
```

- Failed runs (`has_error`) are **excluded from all rate denominators** and
  surfaced separately as a per-provider **coverage/error** indicator.
- A dedicated **Competitive landscape** view is filtered to
  `othersPresent = true`. The **Cited** cohort ("everywhere we show up") gets
  prominent treatment.

---

## 7. Metric definitions

Per cell (segment × optional theme × provider × run):

| Metric | Definition | Denominator / cohort |
|---|---|---|
| **Mention rate** | `count(mentioned) / N` | N = All (`error IS NULL`) |
| **Avg accuracy** | mean `accuracy_score` over mentioned results; **always show the count averaged over** | Mentioned cohort |
| **Owned-citation rate** | `count(owned_cited) / N` | N = All |
| **1st-place rate** | `count(brand_rank = 1) / count(others_present = true)` — "when in a competitive answer, how often are we top pick"; show competitive denominator | Competitive cohort |
| **Competitor share-of-voice** | per competitor `count(mentioned=true) / N` | N = All (mentioned-only rows stored) |
| **Coverage / error rate** | `count(has_error) / attempted`, per provider | Attempted (shown separately) |

- **Cross-provider headline** = **pool all (prompt×provider) results** in the
  segment (prompt set is ~uniform across providers, so pooling is unbiased and
  simplest); per-provider breakdown is always one click down.
- **WoW deltas** computed live by comparing a run to the prior run date; green =
  gain, red = loss (semantic color, see §9).

---

## 8. Information architecture

Top-level model: **week-first home + first-class prompt trajectories**.

1. **Run scoreboard (home).** Latest run as the landing view. Headline metrics
   (mention rate, avg accuracy, owned-citation rate, 1st-place rate) with **WoW
   deltas** vs the prior run, broken down per provider. Dominant control = the
   **run switcher** (prev/next + date dropdown). Segment selector +
   cohort funnel are persistent. Theme breakdown expands the scoreboard into
   per-theme rows within the current segment.
   - "Week" navigation steps between **discrete run dates** (03-30, 04-15,
     04-21, …), not calendar weeks — cadence isn't exactly 7 days.
   - Per-run **freshness/provenance** is visible (ingested-at, counts).
2. **Provider drill-down.** From a provider cell → the run's list of
   prompt-results for that provider (sortable/filterable: mentioned, accuracy,
   rank, cited, theme).
3. **Result detail.** Full prompt, `promptMeta`, response text, citations,
   search queries, search results, and the complete judge verdict (mention
   excerpts, accuracy score + reasoning, competitive position, hypothesis).
   Sections gracefully handle emptiness (some providers return no
   citations/search arrays). This is the **editorial reading view** (see §9).
4. **Prompt trajectory.** Every prompt is a first-class entity: its metrics over
   time, a line per provider, with **gaps (not zeros)** where a prompt is absent
   from a run. Sparklines in list rows preview trajectory.
5. **Competitive landscape.** `othersPresent=true` cohort — rank distribution
   and per-competitor share-of-voice over time.
6. **Cited.** The owned-citation cohort — where/how often owned domains appear.

---

## 9. Design system

Dark-only v1. North star: **[fey.com](https://fey.com)**; craft references
@brotzky and @tcosta. Built on **Radix primitives + Tailwind, hand-themed** (not
stock shadcn) to kill the "generated" look. Hybrid: dense operator-console for
aggregates, editorial reading view for single results.

- **Surface:** near-black base (~`#08090A`) with layered elevated surfaces, high
  foreground contrast.
- **Type:** a refined grotesk for UI (Geist/Söhne-class, *not* stock Inter) +
  a monospace with **tabular numerals** for every metric, count, and delta —
  numerals align in columns like a trading terminal.
- **Color is semantic, not decorative:** one neutral accent for interactive
  elements; **green/red reserved strictly for deltas and good/bad signal** (maps
  directly onto gained/lost mention, accuracy up/down, rank improved). No
  gradient heroes, no emoji.
- **Motion (framer-motion):** fast (<200ms) run-switch transitions, animated
  metric counters and chart draw-in, subtle row/hover states. Purposeful only.
- **Charts (visx), themed from scratch:** thin lines, sparse grid, sparklines in
  rows. No default chart-library styling.

  *Amended 2026-09-16 (driver, issue #25).* "Thin lines" is an aesthetic
  direction, not a numeric one. Measured on the near-black surface, `TrendChart`
  at its original stroke weight and palette saturation rendered as an **apparently
  empty panel** at default viewport scale — two independent verification agents
  nearly reported all three instances as blank, including one drawing a single
  unoccluded series. Two of the six behaviours the seed corpus exists to
  demonstrate live only in those charts.

  `TrendChart` therefore uses a heavier stroke and brighter series colours than
  the line above would suggest. The intent is unchanged: still thin by ordinary
  standards, grid still sparse, no default chart-library styling. The deviation is
  scoped to `TrendChart` — `HeatStrip`, `TrajectoryGrid` and the horizontal bars
  are legible as specified and are untouched — and it does not relax the rule that
  **green and red stay reserved for deltas and good/bad signal**, so neither may be
  recruited as an ordinary series colour.

  A chart nobody can see does not serve a dense operator-console.
- **Density & input:** compact 4px-grid rows, keyboard-navigable scoreboard and
  switcher.
- Tokens as CSS variables so a light theme is *possible* later, not built now.

---

## 10. Auth & access control

- **Optional, and off by default.** With `ALLOWED_EMAIL_DOMAINS` unset there is
  no sign-in at all and the dashboard is open. This is what lets a fresh clone
  be useful with nothing but `docker compose up`; it is also why the warning on
  boot is loud.
- When the variable is set: **better-auth** with Google OAuth, gated on a
  server-side check that `email_verified === true` **and** the email's domain
  EXACTLY equals one of the configured domains. Exact equality — not `endsWith`
  or `includes` — is what rejects `evil.example.com`, `example.com.evil.com`
  and `notexample.com`.
- The Google `hd` hosted-domain param is a hint and is **not** trusted as the
  gate: a self-hosted IdP can spoof it, and it is absent for some legitimately
  migrated accounts. The verified-email check is authoritative.
- **The gate fails closed on an empty domain list.** `evaluateAccess` denies
  everything when handed no domains; the decision to serve openly is made by
  the caller, before the gate. This split is deliberate: if "no domains" meant
  "allow everyone" inside the gate, a typo in the env var would silently open
  the dashboard instead of locking it.
- Two enforcement points, both no-ops when unrestricted: `user.create.before`
  (blocks a new account) and `session.create.before` (re-checks on every session
  issuance, covering returning users and later email drift).
- Guards are UX; the data boundary is `lib/require-session.ts`, called by every
  server function before it touches the database. A bypassed guard must yield a
  blank page, never someone else's data.
- Sessions live in the same Postgres (better-auth tables). A real `user` row
  exists from day one for future write-attribution, even though this is
  read-only.

## 11. Deployment & ops

- **`docker compose`**, entirely local. Three services: `db` (Postgres 16 with
  a named volume), `migrate` (a one-shot that applies drizzle migrations and
  exits), and `web`. Works the same on Docker Desktop, OrbStack or Colima.
- **Ordering is enforced, not assumed.** `migrate` waits on the database
  healthcheck; `web` waits on `migrate` completing successfully. Without the
  healthcheck, migrations race first-boot `initdb` and fail with "the database
  system is starting up"; without the `web` dependency, the app can serve
  against an un-migrated schema.
- **One image for both** `migrate` and `web`, so migrations can never be applied
  by a different build of the code than the one serving them.
- **SSL:** the driver requires SSL for any host that is not obviously localhost.
  Inside the compose network the host is `db` and Postgres speaks plaintext, so
  compose sets `DATABASE_SSL=disable` explicitly rather than weakening that
  heuristic for real deployments.
- **Postgres is published on 5432** so the host-side pipeline and `bun run
  ingest` can reach it. They stay on the host because they need your API keys
  and write JSONL into `./results`.
- **Secrets:** nothing committed. Provider keys live in `.env`; auth variables
  are passed through compose from the environment.

## 12. Build plan (suggested phases)

1. **Monorepo restructure** — Bun workspaces; move `src/` → `apps/pipeline/`;
   create `packages/{core,db,ingest}` and `apps/web` skeletons.
2. **`packages/db`** — Drizzle schema (§4) + initial migration.
3. **`packages/ingest`** — reconciler with per-run wholesale replace, hashing,
   provenance, load-time hygiene; backfill all current-era runs.
4. **Auth** — better-auth + Google, domain gate, sessions.
5. **Run scoreboard (home)** — metrics layer, segment selector, cohort funnel,
   run switcher, WoW deltas, per-provider breakdown, theme expansion.
6. **Drill-downs** — provider list, result detail (editorial), prompt
   trajectory, competitive landscape, cited.
7. **Design pass** — Fey-inspired theming, motion, charts, polish.

---

## 13. Deferred / future hooks (modeled now, not built)

- **DB-authoritative config + editor** in the dashboard, with
  `config:export` (DB → `analytics.config.json`). Relational config tables are
  ready for it.
- **Retroactive re-analysis** (late competitors/owned URLs re-judging historical
  runs) — a **pipeline** concern; the dashboard already handles the result via
  hash-based re-ingest + live deltas.
- **Raw provider payload inspection** via the reserved `raw_ref` hook
  (structured-only ingest today).
- **Labels** as an aggregation dimension (`prompt_labels` already populated).
- **Legacy `_results/` backfill** (Feb–Mar 60-prompt era) as a degraded mode.
- **Light theme** (tokens structured to allow it).

---

## 13. Fork-out: from internal tool to template

This repo began as an internal tracker for one company's brand and was
separated into a standalone, forkable project. Four decisions define that split;
each exists because the internal version had the opposite property.

**Brand is configuration, never a constant.** Every brand and competitor name
lives in `analytics.config.json`. Two templates ship: `analytics.config.example.json`
(a fictional to-do app, Taskwell, matching `prompts/default.csv`) and
`analytics.config.demo.json` (Todoist — real and widely written about, so a
first run returns genuine data instead of an all-zero dashboard). The real
config is gitignored.

The failure mode this guards against is silent. `DEFAULT_BRAND_NAME` in
`packages/db/src/queries.ts` was a real brand string; a run whose config
snapshot was missing got mislabelled with a plausible name, and a plausible
wrong label is indistinguishable from a correct one in the UI. The fallback is
now the obviously-unset `"Brand"`.

**Access control is optional and off by default.** See §10. A fork must be
useful with no identity provider, or nobody gets past the first screen.

**Hosting is local.** See §11. A fork must not require an account on a hosting
platform to see the thing run.

**No data ships.** `results/` and `results/analysis/` are gitignored and no
fixtures are committed. A fresh clone has an empty database, and every page is
built to render that state — the scoreboard shows "No runs ingested yet" rather
than an error. This was verified, not assumed: the first working build of the
compose stack 500'd on every page because the server-side session checks had not
learned that auth could be off.

### Things that stay dangerous

- **A skipped test is not a passing test.** `packages/ingest/test/reconcile.test.ts`
  skips its whole suite when no Postgres is reachable, and says so in one line
  that is easy to miss in a wall of green. Run `docker compose up -d db` before
  trusting it.
- **The judge can match nothing.** If `brand.name` and its aliases do not appear
  the way models actually write them, the regex pre-filter short-circuits every
  result and the dashboard reports a confident zero. Zero mentions and a broken
  config look identical. Check excerpts, not just counts.
- **Provider drift is partial.** An SDK change breaks one provider while the
  other six still write rows, so a run completes and the numbers move for
  reasons that have nothing to do with the brand. Errors are captured per
  result; read them.
