import { createFileRoute } from "@tanstack/react-router";
import { Nav } from "../components/Nav";
import { resolveUser } from "../lib/route-guard";
import { fetchRuns } from "../lib/runs";

export const Route = createFileRoute("/runs")({
  beforeLoad: resolveUser,
  loader: async ({ context }) => ({
    user: context.user,
    runs: await fetchRuns(),
  }),
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
  const { user, runs } = Route.useLoaderData();
  return (
    <main className="shell">
      <Nav active="runs" segment="global" email={user?.email} />
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
                <th className="runs__num">Orphans</th>
                <th>Status</th>
                <th>Ingested</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runDate}>
                  <td className="runs__date">{run.runDate}</td>
                  <td className="runs__num">{run.resultCount}</td>
                  <td className="runs__num">{run.verdictCount}</td>
                  <td className="runs__num">{run.orphanVerdictCount}</td>
                  <td>
                    <span
                      className={
                        run.status === "ok"
                          ? "runs__status runs__status--ok"
                          : "runs__status runs__status--warn"
                      }
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="runs__ts">
                    {formatTimestamp(run.ingestedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
