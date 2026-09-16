import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * The weekly workflow is a deliverable, not scaffolding: it holds the only
 * credential-bearing scheduled job in the repo, and it is the one file that
 * states where the automated chain stops. Nothing else in `bun test` reads it,
 * so a typo in the YAML or a silently-dropped guard would ship green.
 *
 * These tests parse the real file and, for the guards, execute the real shell
 * blocks lifted straight out of it — no reimplementation of the script here,
 * or the test would pass while the shipped workflow rotted.
 */

const WORKFLOW_PATH = resolve(
  import.meta.dir,
  "../.github/workflows/weekly-run.yml",
);

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  if?: string;
};

const source = await readFile(WORKFLOW_PATH, "utf-8");
const workflow = Bun.YAML.parse(source) as {
  name: string;
  on: { schedule?: { cron: string }[]; workflow_dispatch?: unknown };
  jobs: Record<string, { steps: Step[] }>;
};
const steps = workflow.jobs.run.steps;

function stepIndex(match: string): number {
  const i = steps.findIndex((s) => s.name?.includes(match));
  if (i === -1) throw new Error(`no step whose name contains "${match}"`);
  return i;
}

/** Run a step's `run:` block exactly as written, under a given environment. */
async function runStep(match: string, env: Record<string, string>) {
  const script = steps[stepIndex(match)].run;
  if (!script) throw new Error(`step "${match}" has no run block`);
  const proc = Bun.spawn(["bash", "-c", script], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, output: stdout + stderr };
}

describe("weekly-run.yml", () => {
  test("parses as YAML and keeps its dispatch and schedule triggers", () => {
    expect(workflow.on.schedule).toEqual([{ cron: "0 9 * * 1" }]);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
  });

  test("states where the chain stops before the first line of YAML", () => {
    const header = source.slice(0, source.indexOf("name:"));
    // A reader must learn the stopping point and the two commands they own
    // without leaving the file.
    expect(header).toContain("STOPS AFTER THE PIPELINE");
    expect(header).toContain("bun run analyze");
    expect(header).toContain("bun run ingest");
    expect(header).toContain("analytics.config.json");
  });

  test("does not itself run analyze or ingest", () => {
    // Anchored to the start of a line: the job summary *prints* both commands
    // for the operator, and printing them is the point of this slice.
    const scripts = steps.map((s) => s.run ?? "").join("\n");
    expect(scripts).not.toMatch(/^\s*bun run analyze/m);
    expect(scripts).not.toMatch(/^\s*bun run ingest/m);
  });

  test("checks for keys before spending a single provider call", () => {
    expect(stepIndex("Preflight")).toBeLessThan(stepIndex("Run web search"));
  });

  test("inspects the results before uploading them", () => {
    expect(stepIndex("Results are usable")).toBeLessThan(
      stepIndex("Upload results"),
    );
  });

  test("pins Bun rather than tracking latest", () => {
    const setup = steps.find((s) => s.uses?.startsWith("oven-sh/setup-bun"));
    expect(setup).toBeDefined();
    expect(source).toMatch(/bun-version: 1\.3\.14/);
  });
});

describe("preflight guard", () => {
  test("fails with a named error when no provider key is configured", async () => {
    const r = await runStep("Preflight", {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error title=No provider keys configured::");
    // The message has to name the fix, not just the fault.
    expect(r.output).toContain("OPENAI_API_KEY");
    expect(r.output).toContain("repository secret");
  });

  test("treats an empty-string secret as missing", async () => {
    // An unset GitHub secret interpolates to "", not to an absent variable —
    // so `[ -n ]` is the check that matters and `[ -v ]` would pass everything.
    const r = await runStep("Preflight", {
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      OPENROUTER_API_KEY: "",
      PERPLEXITY_API_KEY: "",
      EXA_API_KEY: "",
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("No provider keys configured");
  });

  test("passes on one key, and says which ones are absent", async () => {
    const r = await runStep("Preflight", { ANTHROPIC_API_KEY: "sk-test" });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("provider keys present: ANTHROPIC_API_KEY");
    expect(r.output).toContain(
      "::warning title=Some provider keys are missing::",
    );
    expect(r.output).toContain("OPENAI_API_KEY");
  });

  test("is silent about missing keys when every key is set", async () => {
    const r = await runStep("Preflight", {
      OPENAI_API_KEY: "x",
      ANTHROPIC_API_KEY: "x",
      OPENROUTER_API_KEY: "x",
      PERPLEXITY_API_KEY: "x",
      EXA_API_KEY: "x",
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain("::warning");
  });
});

/**
 * The guard these tests cover is the slice's own thesis pointed at itself: it
 * exists to stop a scheduled run uploading a plausible-but-unusable artefact,
 * and round 1 shipped a version that counted lines — which passes an empty file
 * and passes a file of nothing but 401s, since an all-error run writes exactly
 * as many rows as a good one. Every case below is a file that a line count
 * would have waved through.
 */
describe("usable-results guard", () => {
  async function withResults(rows: Record<string, string>) {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/aio-weekly-${crypto.randomUUID()}`;
    await Bun.write(`${dir}/.keep`, "");
    for (const [name, body] of Object.entries(rows)) {
      await Bun.write(`${dir}/${name}`, body);
    }
    const script = steps[stepIndex("Results are usable")].run;
    if (!script) throw new Error("guard step has no run block");
    // cwd is the repo, because the step runs `bun run scripts/check-results.ts`
    // by its real path; OUTPUT_DIR is the same variable the pipeline writes to,
    // so the guard reads wherever the run actually wrote.
    const proc = Bun.spawn(["bash", "-c", script], {
      cwd: resolve(import.meta.dir, ".."),
      env: { PATH: process.env.PATH ?? "", OUTPUT_DIR: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { output: stdout + stderr, exitCode };
  }

  const ok = (text: string) =>
    `${JSON.stringify({ error: null, responseText: text })}\n`;
  const errored = `${JSON.stringify({
    error: { code: "auth", message: '401 Incorrect API key provided: ""' },
    responseText: "",
  })}\n`;

  test("fails when the pipeline exited 0 having written nothing", async () => {
    const r = await withResults({});
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error title=No results file::");
  });

  test("fails on a file with zero rows", async () => {
    // A line count returns 0 here and the round-1 guard passed it.
    const r = await withResults({ "results-2026-09-14.jsonl": "" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error title=Results file is empty::");
  });

  test("fails when every row carries a provider error", async () => {
    // The measured shape of a run with blank keys: exits 0, full-size file,
    // every row a 401. Six rows, six errors, zero clean.
    const r = await withResults({
      "results-2026-09-14.jsonl": errored.repeat(6),
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error title=No usable results::");
    expect(r.output).toContain("6 carry a provider error");
  });

  test("fails when rows report no error but carry no response text", async () => {
    // error: null is not the same as usable — an empty response has nothing
    // for the judge to score and reaches the dashboard as a confident zero.
    const r = await withResults({
      "results-2026-09-14.jsonl": ok("").repeat(3),
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error title=No usable results::");
    expect(r.output).toContain("3 have no response text");
  });

  test("fails when response text is only whitespace", async () => {
    // Round-2 regression, the reviewer's exact fixture. `" \t "` is an empty
    // answer wearing a costume; it reached the guard as usable.
    const r = await withResults({
      "results-2026-09-14.jsonl": ok(" \t ") + ok("\n  \n"),
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error title=No usable results::");
    expect(r.output).toContain("2 have no response text");
  });

  test("counts a legitimately terse answer as usable", async () => {
    // The guard against over-correcting finding 1 into a minimum length. A
    // short real answer is a real result.
    const r = await withResults({ "results-2026-09-14.jsonl": ok("No.") });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("ok: 1 of 1 rows usable");
  });

  test("fails when the file is not parseable as JSONL", async () => {
    const r = await withResults({
      "results-2026-09-14.jsonl": "not json\nalso not json\n",
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error title=Results file is corrupt::");
  });

  test("fails on one malformed line even when another row is good", async () => {
    // Round-2 regression. A damaged artefact is a different kind of fact from
    // a failed provider: the pipeline records a provider error faithfully,
    // whereas an unparseable line means the file no longer says what the
    // providers said. "Some of it parsed" is not a basis for uploading it.
    const r = await withResults({
      "results-2026-09-14.jsonl": `${ok("Taskwell is a to-do app.")}not json\n`,
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error title=Results file is corrupt::");
    expect(r.output).toContain("1 of 2 lines are not valid JSON");
  });

  test("fails on a single malformed line among many good rows", async () => {
    // Not tolerated at any count — there is no ratio at which corruption
    // becomes acceptable.
    const r = await withResults({
      "results-2026-09-14.jsonl": `${ok("one") + ok("two") + ok("three")}not json\n`,
    });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error title=Results file is corrupt::");
  });

  test("passes a partial run, and says how partial it was", async () => {
    // A single-provider configuration is legitimate — Preflight already warns
    // about it — so one good row among errors must not fail the run.
    const r = await withResults({
      "results-2026-09-14.jsonl":
        ok("Taskwell is a to-do app.") + errored.repeat(5),
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("::warning title=Some results are unusable::");
    expect(r.output).toContain("1 of 6 rows are usable");
    expect(r.output).toContain("ok: 1 of 6 rows usable");
  });

  test("passes a clean run without warning about it", async () => {
    const r = await withResults({
      "results-2026-09-14.jsonl": ok("one") + ok("two") + ok("three"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).not.toContain("::warning");
    expect(r.output).toContain(
      "3 rows, 3 usable, 0 errored, 0 empty, 0 unparseable",
    );
  });

  test("counts every results file the run left behind", async () => {
    const r = await withResults({
      "results-2026-09-14.jsonl": errored,
      "results-2026-09-15.jsonl": ok("something"),
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("ok: 1 of 2 rows usable");
  });
});
