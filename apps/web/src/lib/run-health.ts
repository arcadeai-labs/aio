// The one place a run's health is derived (issue #28). The scoreboard's
// freshness strip and the /runs table are read together, so they must not reach
// the same conclusion by two routes — before this module existed, /runs printed
// the raw `ingest_runs.status` while the scoreboard derived its own badge, and
// the 2026-08-03 outage week read `partial` on one page and `ok` on the other.
//
// Like segments.ts / scoreboard-view.ts this imports only *types* from @aio/db:
// importing a runtime value would drag the Postgres driver into the browser
// bundle (it throws on load without DATABASE_URL) and break hydration.

/**
 * The provenance counts a run's health is derived from — structurally the
 * shared shape of `RunProvenance` (the scoreboard's active run) and
 * `RunSummary` (one /runs row).
 */
export interface RunCounts {
  resultCount: number;
  verdictCount: number;
  orphanVerdictCount: number;
  /**
   * The raw `ingest_runs.status` written by the reconciler. It tracks whether
   * the *files* were read cleanly ("ok" / "ok_with_orphans"), not whether every
   * provider call succeeded — which is exactly why it cannot be the status a
   * reader sees.
   */
  status: string;
}

export interface RunHealth {
  /**
   * Results that never produced a verdict — exactly the errored provider calls,
   * since every error-free result carries a verdict. Never negative: a run with
   * more verdicts than results is an orphan problem, counted below.
   */
  missingVerdicts: number;
  /** Verdicts with no matching result. A different condition from a verdict gap. */
  orphanVerdicts: number;
  /** True when the run is anything other than completely clean. */
  degraded: boolean;
  /** The chip's text: the vocabulary both pages share. */
  label: string;
}

/**
 * Derive what a reader should be told about a run.
 *
 * A run is `ok` only when every result carries a verdict, no verdict is
 * orphaned, and ingest itself read the files cleanly. A verdict gap makes it
 * `partial` — the scoreboard's existing word — because a sixth of the run being
 * missing is the thing a run-health page exists to surface. A non-"ok" ingest
 * status outranks both and is shown verbatim: when ingest itself is the problem,
 * naming it beats flattening it to "partial".
 */
export function runHealth(run: RunCounts): RunHealth {
  const missingVerdicts = Math.max(0, run.resultCount - run.verdictCount);
  const orphanVerdicts = run.orphanVerdictCount;
  const degraded =
    run.status !== "ok" || orphanVerdicts > 0 || missingVerdicts > 0;
  const label = run.status !== "ok" ? run.status : degraded ? "partial" : "ok";
  return { missingVerdicts, orphanVerdicts, degraded, label };
}
