import type { OwnedReachPoint, OwnedUrlAggregate, Segment } from "@aio/db";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AnimatedNumber } from "../components/AnimatedNumber";
import { Nav } from "../components/Nav";
import { SegmentPills } from "../components/SegmentPills";
import { TrendChart, type TrendSeries } from "../components/TrendChart";
import { fetchCitedView } from "../lib/cited";
import {
  CITED_THEME_ALL,
  REACH_LINE,
  count,
  displayUrl,
  pct,
  shortDate,
} from "../lib/cited-view";
import { resolveUser } from "../lib/route-guard";
import { SEGMENT_LABEL, toSegment } from "../lib/segments";
import { fetchSyntheticRuns } from "../lib/synthetic";

// Segment, the active (focus) run, and the theme scope all change what the
// server computes, so all three live in the URL (shareable, re-scopable) and are
// loader deps. The per-section chart/table toggle is a view preference, kept in
// local state. Mirrors the Competitive Landscape view.
interface CitedSearch {
  segment: Segment;
  run?: string;
  theme: string;
}

function validateSearch(search: Record<string, unknown>): CitedSearch {
  return {
    segment: toSegment(search.segment),
    run: typeof search.run === "string" ? search.run : undefined,
    theme: typeof search.theme === "string" ? search.theme : CITED_THEME_ALL,
  };
}

export const Route = createFileRoute("/cited")({
  validateSearch,
  beforeLoad: resolveUser,
  loaderDeps: ({ search }) => ({
    segment: search.segment,
    run: search.run,
    theme: search.theme,
  }),
  loader: async ({ context, deps }) => {
    const [view, syntheticRuns] = await Promise.all([
      fetchCitedView({
        data: { segment: deps.segment, run: deps.run, theme: deps.theme },
      }),
      fetchSyntheticRuns(),
    ]);
    return { user: context.user, view, syntheticRuns };
  },
  component: Cited,
});

function Cited() {
  const { user, view, syntheticRuns } = Route.useLoaderData();
  const { segment, theme } = Route.useSearch();
  const {
    activeRunDate,
    runDates,
    themes,
    current,
    reachTrend,
    ownedUrls,
    ownedUrlTotal,
  } = view;

  const themeLabel =
    theme === CITED_THEME_ALL ? "all themes" : `theme: ${theme}`;
  // The x-axis for the reach trend is the run dates (ascending) — the same order
  // the trend points carry, so values line up column-for-column.
  const runOrder = reachTrend.map((p) => p.runDate);
  const focusIndex = runOrder.indexOf(activeRunDate ?? "");

  return (
    <main className="shell">
      <Nav
        active="cited"
        segment={segment}
        email={user?.email}
        // No run: the page's trends/sparklines span the whole corpus, so a
        // synthetic run anywhere in it is on screen here.
        syntheticRuns={syntheticRuns}
      />

      <section className="comp">
        <div className="comp__head">
          <div className="comp__crumb">
            <Link
              to="/"
              search={{ segment, byTheme: false, byProvider: false }}
              className="shell__link"
            >
              ← Scoreboard
            </Link>
          </div>
          <h1 className="comp__title">Cited</h1>
          {/* The cohort and its denominator, always labeled (spec §6/§7). The
              Cited cohort is owned_cited = true; reach is read over the All
              cohort (error-free results). */}
          <span className="comp__meta">
            cohort <span className="comp__cohort">owned_cited = true</span> ·{" "}
            {SEGMENT_LABEL[segment]} segment · {themeLabel}
            {current ? (
              <>
                {" "}
                · <span className="comp__den">{count(current.cited)}</span> of{" "}
                <span className="comp__den">{count(current.all)}</span> results
                cited an owned domain in run{" "}
                <span className="comp__rundate">{activeRunDate}</span>
              </>
            ) : activeRunDate ? (
              <> · no results in run {activeRunDate}</>
            ) : null}
          </span>

          <div className="comp__controls">
            {/* Driven by the URL, not by the route's resolved search, so the
                three pills cannot read as two while the loader is in flight —
                see components/SegmentPills (issue #39). */}
            <SegmentPills to="/cited" variant="panel" />

            {/* Theme scope — only themes present in the Cited cohort under the
                current segment are offered. */}
            <ScopeSelect
              label="Theme"
              value={theme}
              options={[
                [CITED_THEME_ALL, "All themes"],
                ...themes.map((t) => [t, t] as [string, string]),
              ]}
              param="theme"
            />

            {/* Focus run — drives the reach stat, the owned-URL list, and the
                focus guide on the trend. The trend itself spans every run. */}
            {runDates.length > 0 && (
              <ScopeSelect
                label="Focus run"
                value={activeRunDate ?? ""}
                options={runDates.map((d) => [d, d] as [string, string])}
                param="run"
              />
            )}
          </div>
        </div>

        {runDates.length === 0 ? (
          <p className="shell__placeholder">No runs ingested yet.</p>
        ) : reachTrend.length === 0 ? (
          <p className="shell__placeholder">
            No results in the {SEGMENT_LABEL[segment]} segment
            {theme === CITED_THEME_ALL ? "" : ` · ${theme}`}. Try another scope.
          </p>
        ) : (
          <>
            <ReachSection
              current={current}
              trend={reachTrend}
              runOrder={runOrder}
              focusIndex={focusIndex}
              // The scope the reach figure and its "N of M results" caption are
              // both computed over (issue #23).
              snapshot={`${segment}·${theme}·${activeRunDate ?? "none"}`}
            />
            <OwnedUrlSection
              urls={ownedUrls}
              total={ownedUrlTotal}
              runDate={activeRunDate}
              segment={segment}
            />
          </>
        )}
      </section>
    </main>
  );
}

// A labeled <select> that navigates by patching one search param, preserving the
// rest. Same pattern as the Competitive view's ScopeSelect.
function ScopeSelect({
  label,
  value,
  options,
  param,
}: {
  label: string;
  value: string;
  options: [string, string][];
  param: "theme" | "run";
}) {
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <label className="comp__filter">
      <span className="comp__filterlabel">{label}</span>
      <select
        className="comp__select"
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          void navigate({
            // biome-ignore lint/suspicious/noExplicitAny: search-updater preserves all params
            search: (prev: any) => ({ ...prev, [param]: next }),
          });
        }}
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

type ViewMode = "chart" | "table";

function ViewToggle({
  view,
  onChange,
}: {
  view: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div className="comp__toggle">
      {(["chart", "table"] as ViewMode[]).map((v) => (
        <button
          key={v}
          type="button"
          className={view === v ? "comp__tog comp__tog--on" : "comp__tog"}
          onClick={() => onChange(v)}
        >
          {v === "chart" ? "Chart" : "Table"}
        </button>
      ))}
    </div>
  );
}

// ── Owned-citation reach ──────────────────────────────────────────────────────

function ReachSection({
  current,
  trend,
  runOrder,
  focusIndex,
  snapshot,
}: {
  current: OwnedReachPoint["reach"] | null;
  trend: OwnedReachPoint[];
  runOrder: string[];
  focusIndex: number;
  /** Segment · theme · focused run — the scope this rate and its denominator
   * caption both describe. Changing scope must swap them together, never tween
   * the rate across the change (issue #23). */
  snapshot: string;
}) {
  const [view, setView] = useState<ViewMode>("chart");

  // One line: owned-citation rate per run (cited / all), null when a run has no
  // error-free results → a gap, not a zero.
  const reachSeries: TrendSeries[] = [
    {
      label: "Owned-citation rate",
      color: REACH_LINE,
      highlighted: true,
      values: trend.map((p) => p.reach.rate),
    },
  ];

  return (
    <div className="comp__block">
      <div className="comp__blockhead">
        <h2 className="comp__blocktitle">Owned-citation reach</h2>
      </div>
      <p className="comp__blocknote">
        Fraction of results that cited an owned domain. Rate is over the All
        cohort (error-free results, N), the same denominator the scoreboard's
        owned-citation rate uses.
      </p>

      {current ? (
        <p className="cited__stat">
          <AnimatedNumber
            className="cited__statnum"
            value={current.rate}
            format={pct}
            snapshot={snapshot}
          />
          <span className="cited__statmeta">
            {count(current.cited)} of {count(current.all)} results · focused run
          </span>
        </p>
      ) : (
        <p className="themes__empty">No results in the focused run.</p>
      )}

      <div className="comp__blockhead">
        <h3 className="comp__subtitle">Owned-citation rate over run dates</h3>
        <ViewToggle view={view} onChange={setView} />
      </div>
      {view === "chart" ? (
        <TrendChart
          series={reachSeries}
          xLabels={runOrder.map(shortDate)}
          xTooltipLabels={runOrder}
          focusIndex={focusIndex}
          format={pct}
          ariaLabel="Owned-citation rate over run dates"
        />
      ) : (
        <ReachTable trend={trend} focusRun={runOrder[focusIndex]} />
      )}
    </div>
  );
}

function ReachTable({
  trend,
  focusRun,
}: {
  trend: OwnedReachPoint[];
  focusRun?: string;
}) {
  return (
    <div className="comp__tablewrap">
      <table className="comp__table">
        <thead>
          <tr>
            <th>Run</th>
            <th className="comp__num">N (all)</th>
            <th className="comp__num">Cited</th>
            <th className="comp__num">Rate</th>
          </tr>
        </thead>
        <tbody>
          {trend.map((p) => {
            const active = p.runDate === focusRun;
            return (
              <tr
                key={p.runDate}
                className={active ? "comp__row comp__row--active" : "comp__row"}
              >
                <td className="comp__rundate">{p.runDate}</td>
                <td className="comp__num">{count(p.reach.all)}</td>
                <td className="comp__num">{count(p.reach.cited)}</td>
                <td className="comp__num comp__num--key">
                  {pct(p.reach.rate)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Owned URLs ────────────────────────────────────────────────────────────────

function OwnedUrlSection({
  urls,
  total,
  runDate,
  segment,
}: {
  urls: OwnedUrlAggregate[];
  total: number;
  runDate: string | null;
  segment: Segment;
}) {
  return (
    <div className="comp__block">
      <div className="comp__blockhead">
        <h2 className="comp__blocktitle">Owned URLs cited</h2>
      </div>
      <p className="comp__blocknote">
        Which owned URLs appear in the focused run{" "}
        {runDate ? <span className="comp__rundate">{runDate}</span> : null}, by
        number of results that cited each. Counts are distinct results; follow a
        chip to that result.
        {total > urls.length
          ? ` Showing the top ${urls.length} of ${count(total)} owned URLs.`
          : ""}
      </p>

      {urls.length === 0 ? (
        <p className="themes__empty">No owned URLs cited in the focused run.</p>
      ) : (
        <ul className="cited__urls">
          {urls.map((u) => (
            <li key={u.url} className="cited__url">
              <div className="cited__urlhead">
                <a
                  className="cited__urllink"
                  href={u.url}
                  target="_blank"
                  rel="noreferrer"
                  title={u.url}
                >
                  {displayUrl(u.url)}
                </a>
                <span className="cited__urlcount">
                  {count(u.resultCount)}{" "}
                  {u.resultCount === 1 ? "result" : "results"}
                </span>
              </div>
              <div className="cited__results">
                {u.results.map((r) => (
                  <Link
                    key={r.resultId}
                    to="/result/$id"
                    params={{ id: r.resultId }}
                    search={{ segment }}
                    className="cited__chip"
                    title={`Open result ${r.resultId}`}
                  >
                    {r.provider}
                  </Link>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
