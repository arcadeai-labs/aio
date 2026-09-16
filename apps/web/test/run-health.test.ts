import { describe, expect, test } from "bun:test";
import { type RunCounts, runHealth } from "../src/lib/run-health";

// `runHealth` is the only place a run's status is decided (issue #28). Before it
// existed, /runs printed the raw `ingest_runs.status` and the scoreboard derived
// its own badge, so the seed corpus's provider-outage week — 96 results, 80
// verdicts on 2026-08-03 — read `partial` on one page and `ok` on the other.
//
// The numbers below are the real corpus's, not invented ones: a clean dataset
// cannot distinguish a working implementation from the broken one.

const run = (over: Partial<RunCounts> = {}): RunCounts => ({
  resultCount: 96,
  verdictCount: 96,
  orphanVerdictCount: 0,
  status: "ok",
  ...over,
});

/** 2026-08-03 — `exa` errored on all 16 of its attempts, so 16 results carry no verdict. */
const OUTAGE = run({ verdictCount: 80 });
/** 2026-07-27 and every other week — every result carries a verdict. */
const CLEAN = run();

describe("runHealth — the outage week vs an adjacent clean one", () => {
  test("a run missing verdicts is never labelled ok", () => {
    expect(runHealth(OUTAGE).label).not.toBe("ok");
    expect(runHealth(OUTAGE).label).toBe("partial");
    expect(runHealth(OUTAGE).degraded).toBe(true);
  });

  test("the gap is counted, not left to be subtracted by eye", () => {
    expect(runHealth(OUTAGE).missingVerdicts).toBe(16);
  });

  test("an adjacent clean run still reads ok", () => {
    expect(runHealth(CLEAN).label).toBe("ok");
    expect(runHealth(CLEAN).degraded).toBe(false);
    expect(runHealth(CLEAN).missingVerdicts).toBe(0);
  });

  test("one missing verdict is enough — the threshold is zero, not a fraction", () => {
    expect(runHealth(run({ verdictCount: 95 })).label).toBe("partial");
  });
});

describe("runHealth — orphans keep their own meaning", () => {
  test("orphaned verdicts degrade the run without being counted as a verdict gap", () => {
    // Verdicts *without* results: the opposite condition, and the reason the two
    // must never be summed into one number.
    const h = runHealth(
      run({ orphanVerdictCount: 3, status: "ok_with_orphans" }),
    );
    expect(h.orphanVerdicts).toBe(3);
    expect(h.missingVerdicts).toBe(0);
    expect(h.degraded).toBe(true);
  });

  test("more verdicts than results never reports a negative gap", () => {
    // A run can only be short of verdicts; a surplus is an orphan problem.
    const h = runHealth(run({ resultCount: 96, verdictCount: 99 }));
    expect(h.missingVerdicts).toBe(0);
  });

  test("a verdict gap does not invent orphans", () => {
    expect(runHealth(OUTAGE).orphanVerdicts).toBe(0);
  });
});

describe("runHealth — ingest status keeps its own vocabulary", () => {
  test("a non-ok ingest status is shown verbatim rather than flattened to partial", () => {
    // Ingest status answers "were the files read cleanly", which is a different
    // failure from "did every provider answer". Naming it beats generalising it.
    expect(runHealth(run({ status: "ok_with_orphans" })).label).toBe(
      "ok_with_orphans",
    );
  });

  test("ingest status outranks a verdict gap when both are present", () => {
    const h = runHealth(run({ verdictCount: 80, status: "ok_with_orphans" }));
    expect(h.label).toBe("ok_with_orphans");
    expect(h.degraded).toBe(true);
    expect(h.missingVerdicts).toBe(16);
  });

  test("an empty run is ok, not partial — zero results owe zero verdicts", () => {
    expect(runHealth(run({ resultCount: 0, verdictCount: 0 })).label).toBe(
      "ok",
    );
  });
});
