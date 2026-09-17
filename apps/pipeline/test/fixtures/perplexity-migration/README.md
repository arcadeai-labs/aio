# Perplexity migration fixtures — captured 2026-09-17, **not recapturable**

Four real API responses, captured with a live Perplexity key on **2026-09-17**,
for the same prompt — `"What is Taskwell and who is it for?"` — against both the
old and the new endpoint.

## Why these are committed rather than left on someone's disk

`baseline-raw.json` and `baseline-parsed.json` came from
`POST https://api.perplexity.ai/chat/completions` with `model: "sonar-pro"`.

**That endpoint stops being served on 2026-09-27, and `sonar-pro` no longer
exists on its replacement.** After that date these files cannot be recreated at
any price, by anyone.

Acceptance criterion 3 of #16 is *"citations and search results are extracted as
before — compared against a pre-migration run, not merely 'present'"*. A
comparison that needs a live key is a comparison nobody will ever run again once
the endpoint is gone. Committing the pair makes that criterion checkable
**credential-free, by anyone, forever** — the property #11 and #34 bought for
`SCHEMA.md` and the seed corpus. `../../perplexity-parity.test.ts` is the check.

## The files

| file | what it is |
|---|---|
| `baseline-raw.json` | the verbatim `POST /chat/completions` exchange: request body, HTTP status, and the untouched response body |
| `baseline-parsed.json` | the `UnifiedResult` the **pre-migration** `PerplexityProvider` produced from that response. The old behaviour, preserved |
| `agent-model-sonar-explicit-raw.json` | the verbatim `POST /v1/agent` exchange — `{model: "perplexity/sonar", input, tools: [{type: "web_search"}]}` — HTTP 200, `status: "completed"` |
| `agent-model-sonar-explicit-parsed.json` | **historical record only — do not read this as expected output.** It is what the phase-1 *investigation* mapper produced, and that mapper sourced `citations` from `content[].annotations`, which is empty on every live call. It therefore contains **zero citations**. The bug it documents is the reason the shipped provider sources citations from `search_results[]` instead |

The parity test does **not** trust the last file. It runs the **shipped
provider** over `agent-model-sonar-explicit-raw.json` and compares that against
`baseline-parsed.json`, so the thing under test is the code that actually runs.

## Credentials

**These files contain no credential.** Responses do not echo the
`Authorization` header, and the captures record request *bodies* without
headers. Re-verified before committing: zero matches for `authorization`,
`bearer` and `api[_-]?key` across all four files, and zero matches for the key
value or any 12-character substring of it.

## Content

The brand is **Taskwell**, the fictional brand from
`analytics.config.example.json`. There is no competitive-sensitive material
here. The search results are real third-party pages that happen to match that
name, captured as the provider returned them.
