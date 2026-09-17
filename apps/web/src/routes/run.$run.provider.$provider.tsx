import type { DrilldownRow } from "@aio/db";
import type { Segment } from "@aio/db";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Nav } from "../components/Nav";
import { fetchProviderDrilldown } from "../lib/drilldown";
import {
  DEFAULT_VIEW,
  type DrilldownView,
  type SortKey,
  THEME_ALL,
  THEME_NONE,
  applyDrilldownView,
  themeOptions,
} from "../lib/drilldown-view";
import { resolveUser } from "../lib/route-guard";
import { SEGMENTS, SEGMENT_LABEL, toSegment } from "../lib/segments";
import { fetchSyntheticRuns } from "../lib/synthetic";

// Segment (and an optional incoming theme) are the *scope* the drill-down
// inherits from the scoreboard — they live in the URL so a drilled-in view is
// shareable and re-scopable. Sort and the yes/no/rank filters are ephemeral list
// controls kept in local state. The theme arriving in the URL pre-selects the
// theme filter, so "respects the active theme scope" is honored on entry while
// the list stays freely re-filterable.
interface DrilldownSearch {
  segment: Segment;
  theme?: string;
}

function validateSearch(search: Record<string, unknown>): DrilldownSearch {
  return {
    segment: toSegment(search.segment),
    theme: typeof search.theme === "string" ? search.theme : undefined,
  };
}

export const Route = createFileRoute("/run/$run/provider/$provider")({
  validateSearch,
  beforeLoad: resolveUser,
  // Run (path), provider (path), and segment (search) all change what the server
  // computes, so all three are loader deps. The local sort/filter never refetch.
  loaderDeps: ({ search }) => ({ segment: search.segment }),
  loader: async ({ context, params, deps }) => {
    const [drilldown, syntheticRuns] = await Promise.all([
      fetchProviderDrilldown({
        data: {
          provider: params.provider,
          segment: deps.segment,
          run: params.run,
        },
      }),
      fetchSyntheticRuns(),
    ]);
    return { user: context.user, drilldown, syntheticRuns };
  },
  component: Drilldown,
});

const score = (mean: number | null): string =>
  mean === null ? "—" : mean.toFixed(2);

const yesNo = (v: boolean | null): string =>
  v === null ? "—" : v ? "Yes" : "No";

const rankLabel = (rank: string | null): string =>
  rank === null ? "—" : rank === "not_ranked" ? "—" : rank;

// A clickable column header that drives the sort: click to sort by this key,
// click again to flip direction. Shows a caret on the active column.
function SortHeader({
  label,
  col,
  view,
  onSort,
  numeric,
}: {
  label: string;
  col: SortKey;
  view: DrilldownView;
  onSort: (key: SortKey) => void;
  numeric?: boolean;
}) {
  const active = view.sortKey === col;
  const caret = active ? (view.sortDir === "asc" ? " ▲" : " ▼") : "";
  return (
    <th className={numeric ? "dd__num" : undefined}>
      <button
        type="button"
        className={active ? "dd__sort dd__sort--active" : "dd__sort"}
        onClick={() => onSort(col)}
        aria-sort={
          active
            ? view.sortDir === "asc"
              ? "ascending"
              : "descending"
            : "none"
        }
      >
        {label}
        {caret}
      </button>
    </th>
  );
}

function Drilldown() {
  const { user, drilldown, syntheticRuns } = Route.useLoaderData();
  const { segment, theme } = Route.useSearch();
  const { provider } = Route.useParams();

  const [view, setView] = useState<DrilldownView>({
    ...DEFAULT_VIEW,
    // Honor the theme scope arriving from the scoreboard, if any.
    theme: theme ?? THEME_ALL,
  });

  const setSort = (key: SortKey) =>
    setView((v) =>
      v.sortKey === key
        ? { ...v, sortDir: v.sortDir === "asc" ? "desc" : "asc" }
        : { ...v, sortKey: key, sortDir: "asc" },
    );

  const { themes, hasNone } = useMemo(
    () => themeOptions(drilldown.rows),
    [drilldown.rows],
  );

  // A theme selected in one segment may not exist in another; after a segment
  // switch refetches a different row set, coerce a now-absent theme back to "all"
  // so the <select> and the filter agree (no orphaned value, no silent zero-rows).
  const effectiveView = useMemo<DrilldownView>(() => {
    const available =
      view.theme === THEME_ALL ||
      (view.theme === THEME_NONE && hasNone) ||
      themes.includes(view.theme);
    return available ? view : { ...view, theme: THEME_ALL };
  }, [view, themes, hasNone]);

  const visible = useMemo(
    () => applyDrilldownView(drilldown.rows, effectiveView),
    [drilldown.rows, effectiveView],
  );

  return (
    <main className="shell">
      <Nav
        active="scoreboard"
        segment={segment}
        email={user?.email}
        syntheticRuns={syntheticRuns}
        run={drilldown.runDate}
      />

      <section className="dd">
        <div className="dd__head">
          <div className="dd__crumb">
            <Link
              to="/"
              search={{ segment, byTheme: false, byProvider: true }}
              className="shell__link"
            >
              ← Scoreboard
            </Link>
          </div>
          <h1 className="dd__title">{provider}</h1>
          <span className="dd__meta">
            {drilldown.runDate ? (
              <>
                run <span className="dd__rundate">{drilldown.runDate}</span> ·{" "}
                {SEGMENT_LABEL[segment]} segment
              </>
            ) : (
              "No runs ingested"
            )}
          </span>
          <div className="dd__segctl">
            {SEGMENTS.map((s) => (
              <Link
                key={s}
                from={Route.fullPath}
                // biome-ignore lint/suspicious/noExplicitAny: search-updater preserves all params
                search={(prev: any) => ({ ...prev, segment: s })}
                className={
                  s === segment ? "dd__seg dd__seg--active" : "dd__seg"
                }
                aria-current={s === segment ? "true" : undefined}
              >
                {SEGMENT_LABEL[s]}
              </Link>
            ))}
          </div>
        </div>

        {!drilldown.exists ? (
          <p className="shell__placeholder">
            {drilldown.runDate
              ? `No results for "${provider}" in run ${drilldown.runDate}. Check the provider name.`
              : "No runs ingested yet."}
          </p>
        ) : drilldown.rows.length === 0 ? (
          // The provider ran (exists), but nothing falls in the active segment —
          // distinct from "unknown provider" above and from a filter that emptied
          // a non-empty set below. Point the analyst at the segment control, since
          // clearing the column filters here would not bring any rows back.
          <p className="shell__placeholder">
            No results for "{provider}" in the {SEGMENT_LABEL[segment]} segment
            of run {drilldown.runDate}. Try another segment.
          </p>
        ) : (
          <>
            <div className="dd__filters">
              <Filter
                label="Mentioned"
                value={view.mentioned}
                onChange={(v) =>
                  setView((s) => ({
                    ...s,
                    mentioned: v as DrilldownView["mentioned"],
                  }))
                }
                options={[
                  ["all", "All"],
                  ["yes", "Mentioned"],
                  ["no", "Not mentioned"],
                ]}
              />
              <Filter
                label="Cited"
                value={view.cited}
                onChange={(v) =>
                  setView((s) => ({ ...s, cited: v as DrilldownView["cited"] }))
                }
                options={[
                  ["all", "All"],
                  ["yes", "Cited"],
                  ["no", "Not cited"],
                ]}
              />
              <Filter
                label="Rank"
                value={view.rank}
                onChange={(v) =>
                  setView((s) => ({ ...s, rank: v as DrilldownView["rank"] }))
                }
                options={[
                  ["all", "All"],
                  ["1", "1st"],
                  ["2", "2nd"],
                  ["3", "3rd"],
                  ["not_ranked", "Not ranked"],
                ]}
              />
              <Filter
                label="Theme"
                value={effectiveView.theme}
                onChange={(v) => setView((s) => ({ ...s, theme: v }))}
                options={[
                  [THEME_ALL, "All themes"],
                  ...themes.map((t) => [t, t] as [string, string]),
                  ...(hasNone
                    ? [[THEME_NONE, "Uncategorized"] as [string, string]]
                    : []),
                ]}
              />
              <span className="dd__count">
                {visible.length} of {drilldown.rows.length}
              </span>
            </div>

            <table className="dd__table">
              <thead>
                <tr>
                  <SortHeader
                    label="Prompt"
                    col="prompt"
                    view={view}
                    onSort={setSort}
                  />
                  <SortHeader
                    label="Theme"
                    col="theme"
                    view={view}
                    onSort={setSort}
                  />
                  <SortHeader
                    label="Mentioned"
                    col="mentioned"
                    view={view}
                    onSort={setSort}
                    numeric
                  />
                  <SortHeader
                    label="Accuracy"
                    col="accuracy"
                    view={view}
                    onSort={setSort}
                    numeric
                  />
                  <SortHeader
                    label="Rank"
                    col="rank"
                    view={view}
                    onSort={setSort}
                    numeric
                  />
                  <SortHeader
                    label="Cited"
                    col="cited"
                    view={view}
                    onSort={setSort}
                    numeric
                  />
                  <th className="dd__num" />
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <DrilldownRowView
                    key={r.resultId}
                    row={r}
                    segment={segment}
                  />
                ))}
              </tbody>
            </table>
            {visible.length === 0 && (
              <p className="themes__empty">
                No rows match the current filters.
              </p>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function Filter({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <label className="dd__filter">
      <span className="dd__filterlabel">{label}</span>
      <select
        className="dd__select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

function DrilldownRowView({
  row,
  segment,
}: { row: DrilldownRow; segment: Segment }) {
  return (
    <tr className={row.hasError ? "dd__row dd__row--error" : "dd__row"}>
      <td className="dd__prompt" title={row.promptText}>
        <Link
          to="/prompt/$promptId"
          params={{ promptId: row.promptId }}
          search={{ segment }}
          className="dd__promptlink"
        >
          {row.promptText}
        </Link>
      </td>
      <td className="dd__theme">{row.runTheme ?? "—"}</td>
      <td className="dd__num">{yesNo(row.mentioned)}</td>
      <td className="dd__num">{score(row.accuracyScore)}</td>
      <td className="dd__num">{rankLabel(row.brandRank)}</td>
      <td className="dd__num">{yesNo(row.ownedCited)}</td>
      <td className="dd__num">
        <Link
          to="/result/$id"
          params={{ id: row.resultId }}
          search={{ segment }}
          className="dd__open"
        >
          Open ›
        </Link>
      </td>
    </tr>
  );
}
