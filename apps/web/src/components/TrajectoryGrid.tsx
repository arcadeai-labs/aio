// Provider × run heatmap for a prompt's trajectory (issue #13). The data is
// ordinal/binary, so a GitHub-contributions-style grid reads it better than a
// line chart: one row per provider, one column per run (oldest → newest), each
// cell colored by the active metric and linking to that result's detail. Absent
// runs render as empty (hatched) cells — the gap rule (never a filled zero).
import type { ProviderTrajectory, Segment, TrajectoryCell } from "@aio/db";
import { Link } from "@tanstack/react-router";
import {
  type TrajectoryMetric,
  cellAppearance,
  rankLabel,
  shortDate,
} from "../lib/trajectory-view";

export function TrajectoryGrid({
  providers,
  runDates,
  metric,
  segment,
}: {
  providers: ProviderTrajectory[];
  /** Run dates ascending — the columns, oldest → newest (time reads left→right). */
  runDates: string[];
  metric: TrajectoryMetric;
  segment: Segment;
}) {
  return (
    <div className="comp__tablewrap">
      <table className="grid">
        <thead>
          <tr>
            <th className="grid__corner" />
            {runDates.map((d) => (
              <th key={d} className="grid__date" title={d}>
                {shortDate(d)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.provider}>
              <th className="grid__rowlabel">{p.provider}</th>
              {p.cells.map((cell, i) => (
                <GridCell
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are a fixed run-aligned grid
                  key={i}
                  cell={cell}
                  provider={p.provider}
                  runDate={runDates[i] ?? ""}
                  metric={metric}
                  segment={segment}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GridCell({
  cell,
  provider,
  runDate,
  metric,
  segment,
}: {
  cell: TrajectoryCell | null;
  provider: string;
  runDate: string;
  metric: TrajectoryMetric;
  segment: Segment;
}) {
  const a = cellAppearance(cell, metric);

  if (a.kind === "absent" || !cell) {
    return (
      <td
        className="grid__cell grid__cell--gap"
        title={`${provider} · ${runDate}: absent (no result this run)`}
      >
        <span className="grid__glyph">·</span>
      </td>
    );
  }

  const v = a.value;
  const valueText = cell.hasError
    ? "error"
    : v === null
      ? "no value"
      : metric.binary
        ? v === 1
          ? "yes"
          : "no"
        : String(v);
  const rank = rankLabel(cell.brandRank);
  const rankNote = rank !== "—" ? ` · rank #${rank}` : "";
  const title = `${provider} · ${runDate} — ${metric.label}: ${valueText}${rankNote} · open result`;

  return (
    <td className="grid__cell">
      <Link
        to="/result/$id"
        params={{ id: cell.resultId }}
        search={{ segment }}
        className="grid__link"
        style={{ background: a.bg, color: a.fg }}
        title={title}
      >
        <span className="grid__glyph">{a.glyph}</span>
      </Link>
    </td>
  );
}
