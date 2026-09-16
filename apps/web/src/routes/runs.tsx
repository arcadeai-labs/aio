import { createFileRoute } from "@tanstack/react-router";
import { Nav } from "../components/Nav";
import { RunStatusChip } from "../components/RunStatusChip";
import { resolveUser } from "../lib/route-guard";
import { runHealth } from "../lib/run-health";
import { fetchRuns } from "../lib/runs";
import { fetchSyntheticRuns } from "../lib/synthetic";

export const Route = createFileRoute("/runs")({
  beforeLoad: resolveUser,
  loader: async ({ context }) => {
    const [runs, syntheticRuns] = await Promise.all([
      fetchRuns(),
      fetchSyntheticRuns(),
    ]);
    return { user: context.user, runs, syntheticRuns };
  },
  component: Runs,
});

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Runs() {
  const { user, runs, syntheticRuns } = Route.useLoaderData();
  // Every run is listed here, so the header marker is corpus-wide; the per-row
  // "seeded" tag below is what keeps a measured week from being read next to an
  // invented one.
  const synthetic = new Set(syntheticRuns);
  return (
    <main className="shell">
      <Nav
        active="runs"
        segment="global"
        email={user?.email}
        syntheticRuns={syntheticRuns}
      />
      <section className="runs">
        <div className="runs__head">
          <h1 className="runs__title">Runs</h1>
          <span className="runs__count">
            {runs.length} ingested {runs.length === 1 ? "run" : "runs"}
          </span>
        </div>
        {runs.length === 0 ? (
          <p className="shell__placeholder">
            No runs ingested yet. Run <code>bun run ingest</code> from the
            pipeline laptop to backfill the corpus.
          </p>
        ) : (
          <table className="runs__table">
            <thead>
              <tr>
                <th>Run date</th>
                <th className="runs__num">Results</th>
                <th className="runs__num">Verdicts</th>
                <th className="runs__num">No verdict</th>
                <th className="runs__num">Orphans</th>
                <th>Status</th>
                <th>Ingested</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                // Same derivation the scoreboard's freshness strip uses, so the
                // two pages cannot label the same run differently (issue #28).
                const health = runHealth(run);
                return (
                  <tr key={run.runDate}>
                    <td className="runs__date">
                      {run.runDate}
                      {/* Sits with the date, not in the status column: seeded is a
                          fact about where the run came from, not about how cleanly
                          it ingested (issue #28's RunStatusChip still owns that). */}
                      {synthetic.has(run.runDate) ? (
                        <span className="runs__seeded">seeded</span>
                      ) : null}
                    </td>
                    <td className="runs__num">{run.resultCount}</td>
                    <td className="runs__num">{run.verdictCount}</td>
                    <td
                      className={
                        health.missingVerdicts > 0
                          ? "runs__num runs__num--warn"
                          : "runs__num"
                      }
                    >
                      {health.missingVerdicts}
                    </td>
                    <td
                      className={
                        health.orphanVerdicts > 0
                          ? "runs__num runs__num--warn"
                          : "runs__num"
                      }
                    >
                      {health.orphanVerdicts}
                    </td>
                    <td>
                      <RunStatusChip run={run} variant="runs" />
                    </td>
                    <td className="runs__ts">
                      {formatTimestamp(run.ingestedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
