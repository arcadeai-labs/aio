#!/usr/bin/env bun
//
// Perplexity Sonar → Agent API validation harness (issue #16, phase 2).
//
// ═══ READ THIS BEFORE HANDING IT A KEY ═══════════════════════════════════
//
// What it sends, to whom, in what order. There is nothing else.
//
//   1. POST https://api.perplexity.ai/chat/completions   ← the OLD endpoint
//      body: { model: "sonar-pro", messages: [{ role: "user", content: <prompt> }] }
//      Captured verbatim. This is the pre-migration baseline and it is the
//      whole reason this script exists — see "Why the baseline is first".
//
//   2. PerplexityProvider().run(...)                      ← the OLD endpoint
//      The live production provider, unmodified, against the same prompt. Its
//      output is the real parsed `UnifiedResult` the pipeline produces today.
//
//   3. GET  https://api.perplexity.ai/v1/agent/models     ← model list probe
//      Read-only. Confirms from the server, not the docs, which ids the Agent
//      API actually serves. Non-fatal if it 404s.
//
//   4. POST https://api.perplexity.ai/v1/agent            ← the NEW endpoint
//      Once per candidate request shape (see CANDIDATES below). Today that is
//      two calls: the documented `preset` replacement for sonar-pro, and an
//      explicit `model` + `web_search` tool.
//
// Four to five HTTPS requests to api.perplexity.ai. No other host is contacted,
// nothing is written outside `results/`, and nothing is committed.
//
// ═══ Credential handling ═════════════════════════════════════════════════
//
// The key is read from PERPLEXITY_API_KEY and resolved through
// `providers/credentials.ts#requireApiKey`, which throws by name if it is
// absent rather than letting an SDK substitute OPENAI_API_KEY (issue #15).
//
// The key value is never printed, never written to a file, never included in an
// error message, and never compared by prefix. The only thing this script says
// about it is booleans:
//
//     PERPLEXITY_API_KEY present?                 true
//     distinct from OPENAI_API_KEY?               true
//
// The second line is a `!==` on two strings whose values never leave this
// process. If it is ever false the script exits before any request is built.
//
// The response bodies it writes to disk contain no credential — responses do
// not echo `Authorization` — and the request bodies it writes contain no
// headers at all. Output lands under `results/`, which is gitignored.
//
// ═══ Why the baseline is first ═══════════════════════════════════════════
//
// Acceptance criterion 3 on #16 is "citations and search results are extracted
// as before — compared against a pre-migration run, not merely 'present'". That
// comparison needs a Perplexity response captured while the old endpoint still
// serves. Perplexity's docs say Sonar is supported until 2026-09-27; after that
// the baseline cannot be created at any price, and criterion 3 becomes
// permanently unmeetable.
//
// So steps 1 and 2 run to completion and write their files before step 4 is
// attempted, and a failure in the Agent API section cannot prevent the baseline
// from having been saved. If you run this script exactly once, before the
// sunset, the perishable half is done.
//
// ═══ Usage ═══════════════════════════════════════════════════════════════
//
//     export PERPLEXITY_API_KEY=...        # or put it in .env, which Bun loads
//     bun run perplexity:migration-check
//
//     # optional
//     PERPLEXITY_CHECK_PROMPT="..."        # default: a branded prompt from
//                                          # prompts/default.csv, chosen because
//                                          # it reliably triggers a web search
//     PERPLEXITY_CHECK_OUTPUT_DIR=...      # default: results/perplexity-migration
//
// Exits 0 only when every gated field passed on at least one candidate shape.
// Exits 1 naming the field that failed.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AgentResponse,
  mapAgentResponseToUnified,
} from "./perplexity-migration/agent-response.js";
import {
  type ComparisonReport,
  compareResults,
} from "./perplexity-migration/compare.js";
import { requireApiKey } from "./providers/credentials.js";
import { PerplexityProvider } from "./providers/perplexity.js";
import type { UnifiedResult } from "./types/unified-result.js";

const OLD_ENDPOINT = "https://api.perplexity.ai/chat/completions";
const AGENT_ENDPOINT = "https://api.perplexity.ai/v1/agent";
const AGENT_MODELS_ENDPOINT = "https://api.perplexity.ai/v1/agent/models";

/** The id in DEFAULT_TARGETS today. The thing being replaced. */
const BASELINE_MODEL = "sonar-pro";

const DEFAULT_PROMPT =
  process.env.PERPLEXITY_CHECK_PROMPT ?? "What is Taskwell and who is it for?";

/**
 * The candidate Agent API request shapes, and the model id each would record in
 * `metadata.model` — which is what week-over-week matching joins on.
 *
 * Both are here because the docs do not settle the choice and the harness
 * should not pretend to. Running both against one key produces the evidence the
 * human needs to decide, in one command.
 */
interface Candidate {
  /** Short name used in filenames and the report. */
  key: string;
  /** What `metadata.model` would become, i.e. the new week-over-week series. */
  recordedModel: string;
  /** One line on what this shape is and what it costs. */
  rationale: string;
  body: Record<string, unknown>;
}

const CANDIDATES: Candidate[] = [
  {
    key: "preset-low",
    recordedModel: "low",
    rationale:
      "Perplexity's own documented replacement for sonar-pro (migration guide, read 2026-09-17: sonar-pro → low). Presets bundle web_search. But the docs also say presets are not pinned — 'calling a preset by name always resolves to the latest Perplexity-recommended configuration' — so the recorded id would be a stable label over a model that can change underneath it. Watch the `model` field in the raw capture: it names what actually answered.",
    body: { preset: "low", input: DEFAULT_PROMPT },
  },
  {
    key: "model-sonar-explicit",
    recordedModel: "perplexity/sonar",
    rationale:
      "Explicit model plus an explicit web_search tool. Pinned, and still Perplexity's own model rather than a third party's. The Agent API model list carries perplexity/sonar and no sonar-pro, so this is a tier down from what is measured today.",
    body: {
      model: "perplexity/sonar",
      input: DEFAULT_PROMPT,
      tools: [{ type: "web_search" }],
    },
  },
];

interface Capture {
  label: string;
  url: string;
  status: number;
  requestBody: unknown;
  responseBody: unknown;
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  label: string,
): Promise<Capture> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { _unparseable: text };
  }
  return {
    label,
    url,
    status: res.status,
    requestBody: body,
    responseBody: parsed,
  };
}

function line(char = "─", n = 78): string {
  return char.repeat(n);
}

function printReport(candidate: Candidate, report: ComparisonReport): void {
  console.log(`\n${line("═")}`);
  console.log(`CANDIDATE  ${candidate.key}`);
  console.log(`records    metadata.model = "${candidate.recordedModel}"`);
  console.log(`request    ${JSON.stringify(candidate.body)}`);
  console.log(line());
  console.log(`  ${"FIELD".padEnd(34)}${"VERDICT".padEnd(12)}RESULT`);
  for (const f of report.fields) {
    const mark = f.passed ? "PASS" : "FAIL";
    console.log(`  ${f.field.padEnd(34)}${f.verdict.padEnd(12)}${mark}`);
    console.log(`      old (sonar-pro): ${f.baseline}`);
    console.log(`      new (agent)    : ${f.agent}`);
    if (!f.passed) console.log(`      ↳ ${f.note}`);
  }
  console.log(line());
  if (report.shapeDifferences.length > 0) {
    console.log("  UnifiedResult SHAPE DIFFERENCES (criterion 4 fails):");
    for (const d of report.shapeDifferences) console.log(`    - ${d}`);
  } else {
    console.log("  UnifiedResult shape: identical on required keys.");
  }
  console.log(`  ${candidate.key}: ${report.passed ? "PASS" : "FAIL"}`);
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const outDir = join(
    process.env.PERPLEXITY_CHECK_OUTPUT_DIR ?? "results/perplexity-migration",
    startedAt.replace(/[:.]/g, "-"),
  );

  // ── Preflight. Nothing is sent until both of these hold. ────────────────
  const apiKey = requireApiKey("PERPLEXITY_API_KEY", "Perplexity");
  const openaiKey = process.env.OPENAI_API_KEY;
  const distinct = openaiKey === undefined || apiKey !== openaiKey;

  console.log(line("═"));
  console.log("PERPLEXITY MIGRATION CHECK — issue #16");
  console.log(`started              ${startedAt}`);
  console.log(`prompt               "${DEFAULT_PROMPT}"`);
  console.log(`output               ${outDir}`);
  console.log("PERPLEXITY_API_KEY present?          true");
  console.log(`distinct from OPENAI_API_KEY?        ${distinct}`);
  console.log(line("═"));

  if (!distinct) {
    // Issue #15: a client aimed at Perplexity holding OpenAI's credential. The
    // comparison is a `!==`; neither value is printed here or anywhere else.
    console.error(
      "\nFAIL: PERPLEXITY_API_KEY is byte-identical to OPENAI_API_KEY.",
    );
    console.error(
      "That is the #15 failure wearing a different hat — a Perplexity request",
    );
    console.error(
      "authenticated with an OpenAI secret. No request was sent. Set a real",
    );
    console.error("PERPLEXITY_API_KEY and run again.");
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  const write = (name: string, data: unknown) =>
    writeFile(join(outDir, name), `${JSON.stringify(data, null, 2)}\n`);

  // ══ STEP 1 & 2: BASELINE FIRST. This is the perishable half. ════════════
  console.log("\n[1/4] Capturing the pre-migration baseline (raw)…");
  console.log(`      POST ${OLD_ENDPOINT}  model=${BASELINE_MODEL}`);
  const baselineRaw = await postJson(
    OLD_ENDPOINT,
    apiKey,
    {
      model: BASELINE_MODEL,
      messages: [{ role: "user", content: DEFAULT_PROMPT }],
    },
    "baseline-raw",
  );
  await write("baseline-raw.json", baselineRaw);
  console.log(`      HTTP ${baselineRaw.status} → baseline-raw.json`);

  console.log("\n[2/4] Capturing the pre-migration baseline (parsed)…");
  console.log("      PerplexityProvider().run() — the live production path");
  const baseline: UnifiedResult = await new PerplexityProvider().run({
    prompt: DEFAULT_PROMPT,
    model: BASELINE_MODEL,
    runId: `perplexity-migration-check-${startedAt}`,
  });
  await write("baseline-parsed.json", baseline);
  console.log(
    `      ${baseline.error ? `ERROR ${baseline.error.code}` : "ok"} — ` +
      `${baseline.searchResults.length} search results, ` +
      `${baseline.citations.length} citations → baseline-parsed.json`,
  );

  console.log(
    "\n      ✓ The baseline is on disk. Everything below can fail freely;",
  );
  console.log("        criterion 3 now has something to compare against.");

  if (baseline.error) {
    console.error(
      `\nFAIL: the baseline call errored (${baseline.error.code}). There is nothing to compare against — fix this before the sunset date.`,
    );
    process.exit(1);
  }

  // ══ STEP 3: what does the server say it serves? ═════════════════════════
  console.log("\n[3/4] Probing the Agent API model list…");
  console.log(`      GET ${AGENT_MODELS_ENDPOINT}`);
  try {
    const res = await fetch(AGENT_MODELS_ENDPOINT, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const body = await res.json().catch(() => null);
    await write("agent-models.json", { status: res.status, body });
    const ids = JSON.stringify(body ?? "");
    console.log(`      HTTP ${res.status} → agent-models.json`);
    console.log(
      `      contains "sonar-pro"? ${ids.includes("sonar-pro")}  ` +
        `contains "perplexity/sonar"? ${ids.includes("perplexity/sonar")}`,
    );
  } catch (err) {
    console.log(
      `      probe failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ══ STEP 4: the Agent API, once per candidate shape ═════════════════════
  console.log("\n[4/4] Calling the Agent API…");
  const reports: Array<{ candidate: Candidate; report: ComparisonReport }> = [];

  for (const candidate of CANDIDATES) {
    console.log(`\n      POST ${AGENT_ENDPOINT}  [${candidate.key}]`);
    const capture = await postJson(
      AGENT_ENDPOINT,
      apiKey,
      candidate.body,
      candidate.key,
    );
    await write(`agent-${candidate.key}-raw.json`, capture);
    console.log(
      `      HTTP ${capture.status} → agent-${candidate.key}-raw.json`,
    );

    const agentResponse = capture.responseBody as AgentResponse;
    if (capture.status >= 400) {
      console.log(
        `      request rejected — see agent-${candidate.key}-raw.json for the body`,
      );
    } else if (agentResponse?.model) {
      // The preset case: this names what actually answered, which the preset
      // id does not. It is the whole reason an unpinned preset is a problem for
      // a week-over-week series.
      console.log(`      server reports model = "${agentResponse.model}"`);
    }

    const agent = mapAgentResponseToUnified(agentResponse ?? {}, {
      prompt: DEFAULT_PROMPT,
      model: candidate.recordedModel,
      runId: baseline.metadata.runId,
    });
    await write(`agent-${candidate.key}-parsed.json`, agent);

    const report = compareResults(baseline, agent);
    reports.push({ candidate, report });
  }

  // ══ Report ══════════════════════════════════════════════════════════════
  for (const { candidate, report } of reports) printReport(candidate, report);

  console.log(`\n${line("═")}`);
  console.log("SUMMARY");
  for (const { candidate, report } of reports) {
    console.log(
      `  ${candidate.key.padEnd(26)}${report.passed ? "PASS" : "FAIL"}  ` +
        `→ metadata.model would become "${candidate.recordedModel}"`,
    );
    console.log(`      ${candidate.rationale}`);
  }
  console.log(`\n  artefacts: ${outDir}`);
  console.log(
    "  The baseline files are the perishable ones. Keep them somewhere that",
  );
  console.log(
    "  is not a gitignored directory on one laptop before 2026-09-27.",
  );

  const anyPassed = reports.some((r) => r.report.passed);
  if (!anyPassed) {
    console.error(`\n${line("═")}`);
    console.error("FAIL: no candidate request shape passed every gated field.");
    for (const { candidate, report } of reports) {
      for (const f of report.fields.filter((x) => !x.passed)) {
        console.error(
          `  ${candidate.key}: ${f.field} — ${f.verdict}: ${f.note}`,
        );
      }
      for (const d of report.shapeDifferences) {
        console.error(`  ${candidate.key}: UnifiedResult shape — ${d}`);
      }
    }
    process.exit(1);
  }

  console.log(`\n${line("═")}`);
  console.log(
    "PASS: at least one candidate shape preserved every gated field.",
  );
  console.log(
    "Which one to ship is a decision for the human — see the SUMMARY above and",
  );
  console.log(
    "the write-up in apps/pipeline/src/perplexity-migration/README.md.",
  );
}

main().catch((err) => {
  // Never interpolate anything that could have come near a credential.
  console.error(`\nFATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
