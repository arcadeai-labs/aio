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
    expect(r.output).toContain("::warning title=Some provider keys are missing::");
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

describe("empty-success guard", () => {
  async function inDir(files: Record<string, string>) {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/aio-weekly-${crypto.randomUUID()}`;
    for (const [name, body] of Object.entries(files)) {
      await Bun.write(`${dir}/${name}`, body);
    }
    await Bun.write(`${dir}/.keep`, "");
    const script = steps[stepIndex("Results were actually written")].run;
    const proc = Bun.spawn(["bash", "-c", script as string], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
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

  test("fails when the pipeline exited 0 having written nothing", async () => {
    const r = await inDir({ "results/.gitkeep": "" });
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("::error title=No results file::");
  });

  test("passes and reports the row count when results exist", async () => {
    const r = await inDir({
      "results/results-2026-09-14.jsonl": '{"a":1}\n{"a":2}\n{"a":3}\n',
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("results/results-2026-09-14.jsonl: 3 rows");
  });
});
