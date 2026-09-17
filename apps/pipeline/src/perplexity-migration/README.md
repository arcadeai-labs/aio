# Perplexity Sonar → Agent API: what the docs settle, and what only a key can

**Issue #16, phase 1. Credential-free research. No provider code was changed.**

Every claim below carries the URL it came from and the date it was read. Nothing
here has been confirmed against a live call, because this phase deliberately had
no Perplexity key. Where the docs do not answer a question, this document says
so rather than guessing — the harness next to it (`../perplexity-migration-check.ts`)
turns each of those gaps into a single command.

---

## 1. The deadline still says what we thought it said

> "Sonar Chat Completions is now Agent API. Sonar will be supported until
> September 27, 2026."

Read 2026-09-17 on both
[`/api-reference/chat-completions-post`](https://docs.perplexity.ai/api-reference/chat-completions-post)
and
[`/docs/agent-api/migrate-from-sonar/overview`](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview).
**Ten days.** The date in the issue holds; nothing has moved.

---

## 2. What is actually being replaced

| | today | Agent API |
|---|---|---|
| canonical path | `POST /v1/sonar` | `POST /v1/agent` |
| OpenAI-SDK alias | `POST /chat/completions` | `POST /v1/responses` |
| base URL | `https://api.perplexity.ai` | `https://api.perplexity.ai/v1` *(note the `/v1`)* |
| SDK call | `client.chat.completions.create()` | `client.responses.create()` |
| request | `messages: [...]` | `input: <string \| items>` |
| response | `choices[0].message.content` | typed `output[]` array, one item per step |

Sources, read 2026-09-17:
[sonar OpenAI compatibility](https://docs.perplexity.ai/docs/sonar/openai-compatibility),
[agent OpenAI compatibility](https://docs.perplexity.ai/docs/agent-api/openai-compatibility),
[migrate how-to](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/how-to).

**The OpenAI SDK still works.** This does not have to become a `fetch` client.
`openai@5.23.2` is already installed in `apps/pipeline` and ships
`client.responses.create()`. Perplexity accepts `/v1/responses` as an alias for
`/v1/agent`, and the docs' own migration path is "point at `/v1` and switch
`chat.completions.create()` to `responses.create()`". Perplexity-specific fields
(`preset`, the `search_results` output item) are not in OpenAI's types and need
the same cast the current provider already uses. Their docs recommend their own
SDK for "full type safety… and preset support"; that is a preference, not a
requirement, and adding a dependency to this repo needs more justification than
type ergonomics.

**Confidence: high on the endpoint and method. Medium on the TypeScript SDK
ergonomics** — the compatibility page's `extra_body` instruction is Python, and
it says TS users "use type casting to pass the preset directly". Nobody has run
that against Perplexity from this repo. The harness does it with plain `fetch`
precisely so the SDK question can be answered separately from the shape question.

---

## 3. `sonar-pro` does not exist on the Agent API

This is the finding that forces a decision.

[`/docs/agent-api/models`](https://docs.perplexity.ai/docs/agent-api/models),
read 2026-09-17: the Agent API model list contains exactly one id with "sonar"
in it — **`perplexity/sonar`**. There is no `sonar-pro` and no
`perplexity/sonar-pro`. `sonar-pro` survives only inside the *legacy Sonar*
pricing structure, i.e. the product being sunset.

Perplexity's own replacement is not a model id at all, it is a **preset**
([migrate how-to](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/how-to)):

| Sonar model | Agent API preset |
|---|---|
| `sonar` | `fast` |
| **`sonar-pro`** | **`low`** |
| `sonar-reasoning-pro` | `medium` |
| `sonar-deep-research` | `high` |

And here is the part that matters for a week-over-week brand tracker.
[`/docs/agent-api/presets`](https://docs.perplexity.ai/docs/agent-api/presets),
read 2026-09-17:

- `low` resolves to **`openai/gpt-5.6-luna`**, with `web_search` + `fetch_url`.
- > "Presets are not pinned to a specific version. Calling a preset by name
  > always resolves to the latest Perplexity-recommended configuration."
- To freeze one, you "copy preset values inline and omit the `preset`
  parameter".

So the documented replacement for `sonar-pro` is (a) an **OpenAI model** wearing
Perplexity's search, and (b) **unpinned** — it can be re-pointed at a different
model, silently, while `metadata.model` in our database still reads `low`.

That is the same failure `targets.ts` already refuses for Exa, in its own words:

> the recorded id is what the week-over-week join uses, so changing the
> synthesis model correctly starts a new series instead of silently continuing
> the old one under a label that no longer describes what produced the answer.

An unpinned preset is a label that stops describing what produced the answer,
and it does it without a commit for anyone to notice.

**This is not mine to decide.** The three shapes, with what each costs:

| option | `metadata.model` | what it measures | pinned? |
|---|---|---|---|
| **A** `preset: "low"` | `low` | `openai/gpt-5.6-luna` today, whatever Perplexity picks tomorrow | **no** |
| **B** `model: "perplexity/sonar"` + explicit `web_search` tool | `perplexity/sonar` | Perplexity's own model — but the base tier, not the `-pro` tier we measure today | yes |
| **C** `model: "openai/gpt-5.6-luna"` + explicit `web_search` | `openai/gpt-5.6-luna` | what preset `low` does today, frozen — but the "perplexity" row now measures an OpenAI model, duplicating the `openai` row's family | yes |

The harness runs **A** and **B** against one key and prints, for each, what came
back and what the server says actually answered. **C** is a one-line edit once A's
raw capture names its model.

---

## 4. Web search is opt-in now — and this is the silent-zero risk

[`/docs/agent-api/tools`](https://docs.perplexity.ai/docs/agent-api/tools), read
2026-09-17:

> "Enable the tool by adding it to the `tools` array. The model decides when to
> call it based on your prompt and instructions."

On chat-completions, search was always on. On the Agent API it is a tool you pass.
The presets bundle `web_search`, so option A gets it for free — but **any
migration that sets an explicit `model` and forgets `tools` produces a fluent,
confident, uncited answer with no error.** Every result would report zero
citations and zero search results; the judge would find no sources; the dashboard
would show a clean number and keep moving.

That is this project's characteristic bug, and the Agent API hands you a loaded
version of it as a default. The harness's `compareResults` scores exactly this
case — good `responseText`, empty `citations` — as `regression` / FAIL, and the
test `"dropped citations FAIL — the silent zero this whole exercise is about"`
pins that behaviour.

Note also, per the docs: **the model decides** whether to call the tool even when
it is enabled. So "we passed `tools`" is not the same as "it searched". The check
has to be on the response, not the request.

---

## 5. The field mapping table

This is the real output of phase 1. Left column is `UnifiedResult`; the migration
is mechanical once this is right.

| `UnifiedResult` field | today (chat-completions) | Agent API | confidence |
|---|---|---|---|
| `responseText` | `choices[0].message.content` | concat of `output[type=message].content[type=output_text].text` (SDKs expose `output_text`) | **high** — documented, and the migration guide calls out this exact swap |
| `searchResults[]` | top-level `search_results[]` | `output[type=search_results].results[]` | **high** |
| `searchResults[].url` | `.url` | `.url` | **high** |
| `searchResults[].title` | `.title` | `.title` | **high** |
| `searchResults[].snippet` | `.snippet ?? ""` | `.snippet ?? ""` | **medium** — field is documented; whether it is populated as reliably needs the key |
| `searchResults[].pageDate` | never set | `.date` (publication date) | **medium** — new; `.last_updated` has no contract home and stays in `rawSearchCalls` |
| `citations[]` | top-level `citations[]`, a flat URL array | `output[type=message].content[].annotations[]` | **medium** — the shape is documented, but whether annotations are emitted on every preset/model combination is not |
| `citations[].url` | the array element | `annotation.url` | **medium** |
| `citations[].title` | looked up by URL in `search_results` | `annotation.title`, falling back to the same URL lookup | **medium** |
| `citations[].citedText` | matching `search_results[].snippet` | same fallback — neither shape ships the cited span's text | **high** (it is a fallback in both) |
| `citations[].startIndex` / `.endIndex` | never set | `annotation.start_index` / `.end_index` | **medium** — a **gain**; these optional contract fields have always been `undefined` here |
| `searchQueries[]` | hard-coded `[]` — chat-completions never said what it searched | `output[type=search_results].queries[]` | **medium** — a **gain**, and the one most likely to be wrong; documented on the tools page, not yet seen |
| `rawSearchCalls[]` | one synthetic call holding `{citations, search_results}` | one per `search_results` output item, with the real `queries` as `queryText`/`rawInput` | **high** |
| `metadata.tokenUsage.inputTokens` | `usage.prompt_tokens` | `usage.input_tokens` | **high** |
| `metadata.tokenUsage.outputTokens` | `usage.completion_tokens` | `usage.output_tokens` | **high** |
| `metadata.tokenUsage.searchRequests` | never set | `usage.tool_calls_details` (invocation counts) | **low** — field names not confirmed; leave unset unless the capture shows otherwise |
| `metadata.estimatedCostUsd` | never set | `usage.cost.total_cost` | **medium** — a **gain**; optional field that already exists in the contract |
| `metadata.model` | `input.model` (`sonar-pro`) | whatever §3 decides — **and the server's own `response.model` may differ from it** | **decision pending** |
| `metadata.searchTool` | literal `"perplexity-sonar"` | proposed `"perplexity-agent"` | **high** — free text, does not participate in the week-over-week join |
| `error` | thrown → `BaseProvider` catch | same; `response.error` and `status: "failed"` also need mapping | **medium** — a non-2xx still throws, but a 200 with `status: "failed"` is a new shape the current catch would miss |

**`UnifiedResult` does not need to change, and neither does `SCHEMA.md`.**
Everything above lands in a field that already exists, and the three gains fill
optional fields that already have columns and already have `SCHEMA.md` rows:
`citations.start_index` / `.end_index` (documented as "only `openai` and
`openrouter` populate it"), `search_results.page_date` ("only `exa` and
`anthropic`"), `results.estimated_cost_usd` ("only `anthropic-agent`"), and the
`search_queries` table. A fourth provider starting to populate them is a data
change, not a schema change — though the "only X populate it" notes in
`SCHEMA.md` would become stale and are worth a follow-up edit in phase 2. `compareShape()` asserts key-set identity rather than
asking anyone to take that on trust, and
`"the mapped Agent result has the same required keys as a chat-completions result"`
is the test.

One thing I looked for and did not find: anything in the Agent API response that
**cannot** map onto the contract. `last_updated`, `source`, the per-result `id`,
`fetch_url_results`, and the cost breakdown all have no first-class home — but
`rawSearchCalls.rawOutput` is exactly the reserved verbatim-payload hook
(DESIGN.md §"Raw provider payload inspection"), so none of them is a reason to
change the contract.

---

## 6. The week-over-week break, factually

`(prompt, provider, model)` is the join. `perplexity` + `sonar-pro` is the
current series.

Under **every** option in §3 the model id changes, because `sonar-pro` does not
exist on the Agent API. So:

- The `perplexity/sonar-pro` series **ends** at the last pre-migration run.
- A new series (`perplexity/low`, or `perplexity/perplexity-sonar`, or
  `perplexity/openai-gpt-5.6-luna`) **begins** at the first post-migration run.
- On the trend chart these are two lines, not one. Per DESIGN.md §"the trend
  renders **gaps (not zeros)** where a prompt is absent", the old line stops and
  the new one starts — it does not fall to zero, which is the correct rendering
  and was a deliberate choice.
- The week-over-week delta for that provider is **absent**, not zero, for the
  first post-migration run. There is no prior row to difference against.
- The cross-provider headline pools all `(prompt × provider)` results, so the
  headline number is continuous. Only the per-provider breakdown shows the break.

**The alternative — writing the new id back onto `sonar-pro` — is available and
is the human's call.** What it buys is one continuous line. What it costs: the
dashboard would assert a continuous measurement across an endpoint change, a
model change, and (under option A) a change from Perplexity's model to OpenAI's.
I am not making this decision; the driver's issue comment already put it to the
human, and both halves of it are now answerable with a concrete id.

---

## 7. #15 — how the new client must take its key

#15 is **closed** (2026-09-16) and the current provider is already correct: it
calls `requireApiKey("PERPLEXITY_API_KEY", "Perplexity")` *before* constructing
the client, so the OpenAI SDK never sees an `undefined` `apiKey` to fill in from
`OPENAI_API_KEY`.

The pattern comes back the moment someone writes
`new OpenAI({ baseURL: ..., apiKey: process.env.PERPLEXITY_API_KEY })`. So, for
phase 2:

- Keep `requireApiKey(...)` resolved **before** the client object exists, whether
  the client ends up being the OpenAI SDK or `fetch`.
- The existing test
  `"perplexity: no request leaves the process, and none carries the OpenAI key"`
  in `apps/pipeline/test/provider-credentials.test.ts` must keep passing
  unmodified against the rewritten client. It asserts the request was never
  *made*, not that it was rejected — do not weaken it to a 401 check.
- The harness asserts the same thing at runtime, as a boolean `!==`, and exits
  before building any request if the two keys are byte-identical. It never
  prints either value, or any part of one.

---

## 8. What needs the key

Everything below is unsettled from documentation alone. **One command settles
all of it**, and it captures the perishable baseline before it touches anything
new:

```sh
export PERPLEXITY_API_KEY=...          # or add it to .env, which Bun loads
bun run perplexity:migration-check
```

| # | question | how the run answers it |
|---|---|---|
| 1 | Does the pre-migration baseline still capture cleanly? | Steps 1–2 write `baseline-raw.json` + `baseline-parsed.json` **before** the Agent API is touched. This is the half that cannot be redone after 2026-09-27. |
| 2 | Does `preset: "low"` actually return `search_results` and `annotations`? | `agent-preset-low-raw.json`, and the per-field PASS/FAIL table |
| 3 | Which model does `low` really resolve to today? | the run prints `server reports model = "…"` from the response |
| 4 | Is `model: "perplexity/sonar"` + `tools: [{type:"web_search"}]` accepted, and does it search? | `agent-model-sonar-explicit-raw.json` + its table |
| 5 | Is `sonar-pro` genuinely absent from the served model list? | step 3 probes `/v1/agent/models` and prints two booleans |
| 6 | Does `search_results.queries` get populated? (`searchQueries` gain) | the `searchQueries` row: `gain` = yes, `unprovable` = the mapping table is wrong |
| 7 | Do annotations carry `start_index`/`end_index` in practice? | the `citations[].startIndex` row |
| 8 | Are token usage fields really `input_tokens`/`output_tokens`? | the two `tokenUsage` rows |
| 9 | Does a 200-with-`status: "failed"` occur, and would the current error path miss it? | visible in the raw captures |
| 10 | Is `UnifiedResult` really shape-identical on real data? | `compareShape` runs on the live pair, not a fixture |

What it does **not** answer, and would need a second command: whether the OpenAI
SDK's TypeScript `responses.create()` cleanly passes `preset` and `tools` through
to Perplexity. The harness uses plain `fetch` on purpose, so that a shape failure
and an SDK failure cannot be confused for each other. If the shapes check out,
the SDK question is a five-minute follow-up.

---

## 9. What I am unsure about

Listed most-likely-to-be-wrong first.

1. **`searchQueries` from `search_results.queries`.** The strongest *new* claim
   in the mapping table and the weakest sourced. It appears on the tools page as
   a field of the `search_results` output item; I have not seen a response
   carrying it, and I do not know whether it is present on preset calls, on
   explicit-model calls, or only when the model runs multiple searches. If it is
   absent, that row is a `unprovable` FAIL in the harness and the table is wrong
   — which is the harness working.

2. **Whether annotations are emitted on every configuration.** The how-to says
   the `fast`/`low`/`medium`/`high` presets "include inline citations
   automatically" and that "custom configurations require explicit instructions."
   Option B in §3 *is* a custom configuration. So option B may return
   `search_results` but no `annotations` — search results present, citations
   empty. That is a partial silent zero: the sources are there, the per-claim
   attribution is not. The harness distinguishes them (`searchResults` and
   `citations` are separate gated rows) but I cannot tell you today which way it
   lands, and if it lands badly it makes option B materially worse than the table
   in §3 suggests.

3. **Whether `model` and `tools` can be combined at all.** Never stated. The docs
   show `preset` and `model` used separately and never together, and the models
   page "does not explain how to pass a model id versus a preset". Options B and
   C both assume the combination works. If it does not, the only supported path
   is an unpinned preset, and §3 collapses to one option with a known drift
   problem.

4. **`usage.tool_calls_details` → `tokenUsage.searchRequests`.** I could not get
   the sub-field names. Marked low confidence and deliberately left unmapped —
   guessing here would put a wrong number in the database, which is worse than a
   `undefined`.

5. **Error semantics.** A 200 carrying `status: "failed"` and a populated `error`
   object is a shape chat-completions did not have. `BaseProvider`'s try/catch
   sees a resolved promise and would record a *successful* result with empty
   text. I believe this needs an explicit check in the phase-2 provider, but I
   have not seen a failed response and do not know how often it occurs or what
   `error` contains.

6. **Doc-reading risk generally.** Every claim here came from Perplexity's docs
   as rendered and summarised on 2026-09-17. I quoted rather than paraphrased
   wherever the wording carried weight (the sunset date, the preset pinning
   statement, the tools-are-opt-in statement) because those are the three that a
   live call is most likely to contradict in public. The confidence column is
   doc-confidence, not call-confidence; **nothing in this document has been
   verified against the live API**, and none of #16's acceptance criteria are met
   by it.

7. **The baseline's durability, which is not a technical question.** The harness
   writes to `results/`, which is gitignored, on one machine. That is the right
   default — it is real competitive data — but it means the perishable artefact
   lives exactly where the driver already warned it lives. Promoting a scrubbed
   fixture into the repo is phase-2 work and needs a human call on what may be
   committed.
