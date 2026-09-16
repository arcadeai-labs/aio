import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import type { BrandConfig } from "@aio/core";
import { createRng } from "../src/seed/rng.js";
import {
  type SeededCorpus,
  type WorldSpec,
  buildCorpus,
  recordedModel,
} from "../src/seed/scenario.js";
import type { PromptEntry, TargetEntry } from "../src/types/config.js";

const BRAND: BrandConfig = {
  name: "Taskwell",
  aliases: ["Taskwell App"],
  ownedDomains: ["taskwell.app", "docs.taskwell.app"],
  groundTruthDescription:
    "Taskwell is a cross-platform to-do and task management app for individuals and small teams.",
  knownCompetitors: ["Todoist", "Things 3", "TickTick"],
};

const PROMPTS: PromptEntry[] = [
  {
    prompt: "What is Taskwell and who is it for?",
    category: "Brand Understanding",
    meta: { topic: "Product Overview", brandedType: "Branded" },
  },
  {
    prompt: "What is the best to-do list app in 2026?",
    category: "Discovery & Recommendation",
    meta: { topic: "Recommendation", brandedType: "Unbranded" },
  },
  {
    prompt: "Which to-do apps have the best keyboard-driven interfaces?",
    category: "Feature & Capability",
    meta: { topic: "Usability", brandedType: "Unbranded" },
  },
];

const TARGETS: TargetEntry[] = [
  { provider: "openai", model: "gpt-5.6-terra" },
  { provider: "anthropic", model: "claude-sonnet-5" },
  {
    provider: "exa",
    model: "exa-auto",
    options: { synthesisProvider: "openai", synthesisModel: "gpt-5.6-luna" },
  },
];

const SPEC: WorldSpec = {
  brand: BRAND,
  prompts: PROMPTS,
  targets: TARGETS,
  anchorDate: "2026-09-14",
  weeks: 2,
  judgeModel: { provider: "openai", model: "gpt-5.2" },
};

function build(seed = "aio-tracer", spec: WorldSpec = SPEC): SeededCorpus {
  return buildCorpus(spec, createRng(seed));
}

describe("buildCorpus — determinism", () => {
  test("the same spec and seed produce an identical corpus", () => {
    expect(build()).toEqual(build());
  });

  test("a different seed produces a different corpus", () => {
    expect(build("aio-tracer")).not.toEqual(build("somewhere-else"));
  });

  test("identity is in the seed, not the clock: ids and timestamps repeat", () => {
    const a = build().runs[0].results[0];
    const b = build().runs[0].results[0];
    expect(a.id).toBe(b.id);
    expect(a.metadata.startedAt).toBe(b.metadata.startedAt);
    expect(a.metadata.runId).toBe(b.metadata.runId);
  });

  test("result ids are unique across the whole corpus", () => {
    const corpus = build();
    const ids = corpus.runs.flatMap((r) => r.results.map((x) => x.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("buildCorpus — run dates", () => {
  test("produces `weeks` runs, oldest first, anchored on anchorDate", () => {
    expect(build().runs.map((r) => r.runDate)).toEqual([
      "2026-09-07",
      "2026-09-14",
    ]);
  });

  test("consecutive runs are exactly 7 days apart", () => {
    const dates = build("aio-tracer", { ...SPEC, weeks: 5 }).runs.map(
      (r) => r.runDate,
    );
    expect(dates.length).toBe(5);
    for (let i = 1; i < dates.length; i++) {
      const delta = Date.parse(dates[i]) - Date.parse(dates[i - 1]);
      expect(delta).toBe(7 * 86_400_000);
    }
  });

  test("steps back over a month boundary without drifting", () => {
    const dates = build("aio-tracer", {
      ...SPEC,
      anchorDate: "2026-03-02",
      weeks: 3,
    }).runs.map((r) => r.runDate);
    expect(dates).toEqual(["2026-02-16", "2026-02-23", "2026-03-02"]);
  });

  test("every timestamp on a run falls on that run's date", () => {
    for (const run of build().runs) {
      for (const result of run.results) {
        expect(result.metadata.startedAt.slice(0, 10)).toBe(run.runDate);
        expect(result.metadata.completedAt.slice(0, 10)).toBe(run.runDate);
      }
      for (const verdict of run.verdicts) {
        expect(verdict.analyzedAt.slice(0, 10)).toBe(run.runDate);
      }
    }
  });

  test("rejects a malformed anchor date rather than inventing one", () => {
    expect(() => build("s", { ...SPEC, anchorDate: "14/09/2026" })).toThrow(
      "anchorDate must be YYYY-MM-DD",
    );
  });

  test("rejects an empty world rather than writing an empty corpus", () => {
    expect(() => build("s", { ...SPEC, weeks: 0 })).toThrow("at least 1");
    expect(() => build("s", { ...SPEC, prompts: [] })).toThrow("prompts");
    expect(() => build("s", { ...SPEC, targets: [] })).toThrow("targets");
  });
});

describe("buildCorpus — the week-over-week join", () => {
  // Comparison matches on (prompt, provider, model). If any of the three drifts
  // between weeks, the old series ends silently and a new one begins — which
  // looks like a gap in the trend, not like a bug.
  const key = (prompt: string, provider: string, model: string) =>
    [prompt, provider, model].join(" :: ");

  test("every week carries the same (prompt, provider, model) key set", () => {
    const weeks = build("aio-tracer", { ...SPEC, weeks: 4 }).runs.map((run) =>
      run.results
        .map((r) => key(r.prompt, r.metadata.provider, r.metadata.model))
        .sort(),
    );
    expect(weeks[0].length).toBe(PROMPTS.length * TARGETS.length);
    for (const week of weeks.slice(1)) {
      expect(week).toEqual(weeks[0]);
    }
  });

  test("prompt text is byte-identical to the spec, never reworded", () => {
    const texts = new Set(
      build().runs.flatMap((r) => r.results.map((x) => x.prompt)),
    );
    expect([...texts].sort()).toEqual(PROMPTS.map((p) => p.prompt).sort());
  });

  test("records exa under the model it reports, not the configured label", () => {
    // providers/exa.ts rewrites metadata.model to `exa+<synthesisModel>`, and
    // the join reads the recorded value. Seeded rows have to agree.
    expect(recordedModel(TARGETS[2])).toBe("exa+gpt-5.6-luna");
    const models = new Set(
      build()
        .runs.flatMap((r) => r.results)
        .filter((r) => r.metadata.provider === "exa")
        .map((r) => r.metadata.model),
    );
    expect([...models]).toEqual(["exa+gpt-5.6-luna"]);
  });

  test("carries promptCategory and promptMeta through untouched", () => {
    const branded = build().runs[0].results.filter(
      (r) => r.prompt === "What is Taskwell and who is it for?",
    );
    expect(branded.length).toBe(TARGETS.length);
    for (const r of branded) {
      expect(r.promptCategory).toBe("Brand Understanding");
      expect(r.promptMeta).toEqual({
        topic: "Product Overview",
        brandedType: "Branded",
      });
    }
  });
});

describe("buildCorpus — results and verdicts line up", () => {
  test("every verdict points at a result in its own run", () => {
    for (const run of build().runs) {
      const ids = new Set(run.results.map((r) => r.id));
      for (const v of run.verdicts) expect(ids.has(v.resultId)).toBe(true);
    }
  });

  test("errored results get no verdict; every other result gets exactly one", () => {
    // Mirrors analytics/analyzer.ts, which judges only `error === null` rows.
    for (const run of build("aio-tracer", { ...SPEC, weeks: 8 }).runs) {
      const judged = new Set(run.verdicts.map((v) => v.resultId));
      expect(judged.size).toBe(run.verdicts.length);
      for (const r of run.results) {
        expect(judged.has(r.id)).toBe(r.error === null);
      }
    }
  });

  test("an errored result carries an error code and no response", () => {
    const errored = build("aio-tracer", { ...SPEC, weeks: 12 })
      .runs.flatMap((r) => r.results)
      .filter((r) => r.error !== null);
    expect(errored.length).toBeGreaterThan(0);
    for (const r of errored) {
      expect(r.error?.code).toMatch(/^HTTP_\d{3}$/);
      expect(r.responseText).toBe("");
      expect(r.citations).toEqual([]);
    }
  });

  test("a verdict repeats its result's prompt, provider and model", () => {
    for (const run of build().runs) {
      const byId = new Map(run.results.map((r) => [r.id, r]));
      for (const v of run.verdicts) {
        const r = byId.get(v.resultId);
        expect(v.prompt).toBe(r?.prompt ?? "");
        expect(v.provider).toBe(r?.metadata.provider ?? "");
        expect(v.model).toBe(r?.metadata.model ?? "");
      }
    }
  });
});

describe("buildCorpus — the brand actually matched something", () => {
  // A corpus where nothing matched renders a clean, believable 0% that is
  // indistinguishable from a brand nobody mentions. Assert excerpts, not counts.
  test("some results mention the brand and some do not", () => {
    const verdicts = build().runs.flatMap((r) => r.verdicts);
    const mentioned = verdicts.filter((v) => v.brandMention.mentioned);
    expect(mentioned.length).toBeGreaterThan(0);
    expect(mentioned.length).toBeLessThan(verdicts.length);
  });

  test("every excerpt is a verbatim slice of the response it came from", () => {
    const corpus = build("aio-tracer", { ...SPEC, weeks: 4 });
    let checked = 0;
    for (const run of corpus.runs) {
      const byId = new Map(run.results.map((r) => [r.id, r]));
      for (const v of run.verdicts) {
        const text = byId.get(v.resultId)?.responseText ?? "";
        for (const excerpt of v.brandMention.excerpts) {
          expect(text).toContain(excerpt);
          expect(excerpt).toContain(BRAND.name);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test("mentionCount equals the number of excerpts, and is zero when absent", () => {
    for (const run of build("aio-tracer", { ...SPEC, weeks: 4 }).runs) {
      for (const v of run.verdicts) {
        expect(v.brandMention.mentionCount).toBe(
          v.brandMention.excerpts.length,
        );
        if (!v.brandMention.mentioned) {
          expect(v.brandMention.mentionCount).toBe(0);
        }
      }
    }
  });

  test("an unmentioned brand never has prose naming it", () => {
    for (const run of build("aio-tracer", { ...SPEC, weeks: 4 }).runs) {
      const byId = new Map(run.results.map((r) => [r.id, r]));
      for (const v of run.verdicts) {
        if (v.brandMention.mentioned) continue;
        expect(byId.get(v.resultId)?.responseText).not.toContain(BRAND.name);
      }
    }
  });
});

describe("buildCorpus — verdict coherence", () => {
  test("a brand that was not mentioned is never ranked", () => {
    for (const run of build("aio-tracer", { ...SPEC, weeks: 6 }).runs) {
      for (const v of run.verdicts) {
        if (v.brandMention.mentioned) continue;
        expect(v.competitivePosition.brandRank).toBe("not_ranked");
      }
    }
  });

  test("othersPresent and othersCount agree with the competitor list", () => {
    for (const run of build("aio-tracer", { ...SPEC, weeks: 6 }).runs) {
      for (const v of run.verdicts) {
        const named = v.competitivePosition.competitors.filter(
          (c) => c.mentioned,
        );
        expect(v.competitivePosition.othersCount).toBe(named.length);
        expect(v.competitivePosition.othersPresent).toBe(named.length > 0);
      }
    }
  });

  test("the competitor enum lists every configured competitor on every row", () => {
    // Ingest filters this to mentioned=true; the source shape lists them all.
    for (const run of build().runs) {
      for (const v of run.verdicts) {
        expect(v.competitivePosition.competitors.map((c) => c.name)).toEqual(
          BRAND.knownCompetitors,
        );
      }
    }
  });

  test("accuracy is scored only where the brand was described", () => {
    for (const run of build("aio-tracer", { ...SPEC, weeks: 6 }).runs) {
      for (const v of run.verdicts) {
        if (v.brandMention.mentioned) {
          expect(v.descriptionAccuracy).not.toBeNull();
          expect([1, 2, 3, 4, 5]).toContain(
            v.descriptionAccuracy?.score as number,
          );
          expect(v.descriptionAccuracy?.reasoning.length).toBeGreaterThan(0);
        } else {
          expect(v.descriptionAccuracy).toBeNull();
        }
      }
    }
  });

  test("an owned citation is always backed by an owned URL in the result", () => {
    const corpus = build("aio-tracer", { ...SPEC, weeks: 4 });
    let cited = 0;
    for (const run of corpus.runs) {
      const byId = new Map(run.results.map((r) => [r.id, r]));
      for (const v of run.verdicts) {
        expect(v.ownedCitation.cited).toBe(v.ownedCitation.urls.length > 0);
        if (!v.ownedCitation.cited) continue;
        cited++;
        const urls = new Set(byId.get(v.resultId)?.citations.map((c) => c.url));
        for (const url of v.ownedCitation.urls) {
          expect(urls.has(url)).toBe(true);
          expect(BRAND.ownedDomains.some((d) => url.includes(d))).toBe(true);
        }
      }
    }
    expect(cited).toBeGreaterThan(0);
  });

  test("only a mentioned brand can own a citation", () => {
    for (const run of build("aio-tracer", { ...SPEC, weeks: 6 }).runs) {
      for (const v of run.verdicts) {
        if (v.ownedCitation.cited) expect(v.brandMention.mentioned).toBe(true);
      }
    }
  });

  test("every citation URL is one the result actually surfaced", () => {
    for (const run of build().runs) {
      for (const r of run.results) {
        const surfaced = new Set(r.searchResults.map((s) => s.url));
        for (const c of r.citations) expect(surfaced.has(c.url)).toBe(true);
      }
    }
  });
});

describe("seed purity", () => {
  // AC7/AC9. The determinism tests above prove the behaviour; this pins the
  // reason, so a later change that reaches for the filesystem or the clock
  // fails here instead of quietly making the corpus unreproducible.
  //
  // One stray `Math.random` introduced while tuning the world model would break
  // reproducibility while leaving every *property* test green — the properties
  // hold for any plausible world. This is the check that stands between the
  // corpus being an artefact and being a coincidence, so it covers the whole
  // pure core, not just the file that happened to need it first.
  const PURE_MODULES = ["scenario.ts", "world.ts", "prose.ts", "rng.ts"];
  /** Whatever a pure module may import. Nothing here reaches the outside world. */
  const ALLOWED_IMPORTS = new Set([
    "@aio/core",
    "../types/config.js",
    "./rng.js",
    "./world.js",
    "./prose.js",
  ]);

  // Strip comments first — the modules' own headers name the things they promise
  // not to do, and a scan that cannot tell code from prose would fail on the
  // promise rather than on a breach of it.
  const sourceOf = (file: string) =>
    readFileSync(new URL(`../src/seed/${file}`, import.meta.url), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

  test.each(PURE_MODULES)(
    "%s imports nothing from node:fs, node:path or a network client",
    (file) => {
      const code = sourceOf(file);
      for (const [, specifier] of code.matchAll(/from\s+"([^"]+)"/g)) {
        expect(ALLOWED_IMPORTS.has(specifier)).toBe(true);
      }
      expect(code).not.toMatch(/\brequire\s*\(/);
      expect(code).not.toMatch(/\bimport\s*\(/);
    },
  );

  test.each(PURE_MODULES)(
    "%s references neither Date.now() nor Math.random",
    (file) => {
      const code = sourceOf(file);
      expect(code).not.toContain("Date.now");
      expect(code).not.toContain("Math.random");
    },
  );

  test("no file anywhere under seed/ reaches for Math.random", () => {
    // index.ts and emit.ts are allowed their filesystem access — they exist to
    // do the I/O the pure core refuses. Neither is allowed a second source of
    // variation: a `Math.random()` there would be just as fatal to
    // reproducibility and would sit outside the checks above.
    const files = readdirSync(new URL("../src/seed/", import.meta.url)).filter(
      (f) => f.endsWith(".ts"),
    );
    expect(files.length).toBeGreaterThanOrEqual(PURE_MODULES.length);
    for (const file of files) {
      const code = sourceOf(file);
      expect({ file, hit: code.includes("Math.random") }).toEqual({
        file,
        hit: false,
      });
    }
  });
});
