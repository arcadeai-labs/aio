import type {
  BrandShareOfVoice,
  BrandSovPoint,
  CompetitivePoint,
  CompetitorSeries,
  RankDistribution,
  RankTrendPoint,
  Segment,
} from "@aio/db";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Nav } from "../components/Nav";
import { TrendChart, type TrendSeries } from "../components/TrendChart";
import { fetchCompetitiveLandscape } from "../lib/competitive";
import {
  BRAND_MARKER,
  BRAND_RANK_KEYS,
  BRAND_SOV,
  COMPETITIVE_THEME_ALL,
  RANK_COLOR,
  RANK_LABEL,
  SOV_BAR,
  SOV_HIGHLIGHT_COUNT,
  SOV_PALETTE,
  count,
  pct,
  shortDate,
} from "../lib/competitive-view";
import { resolveUser } from "../lib/route-guard";
import { SEGMENTS, SEGMENT_LABEL, toSegment } from "../lib/segments";
import { fetchSyntheticRuns } from "../lib/synthetic";

// Segment, the active (focus) run, and the theme scope all change what the
// server computes, so all three live in the URL (shareable, re-scopable) and are
// loader deps. The per-section chart/table toggle is a view preference, kept in
// local state.
interface CompetitiveSearch {
  segment: Segment;
  run?: string;
  theme: string;
}

function validateSearch(search: Record<string, unknown>): CompetitiveSearch {
  return {
    segment: toSegment(search.segment),
    run: typeof search.run === "string" ? search.run : undefined,
    theme:
      typeof search.theme === "string" ? search.theme : COMPETITIVE_THEME_ALL,
  };
}

export const Route = createFileRoute("/competitive")({
  validateSearch,
  beforeLoad: resolveUser,
  loaderDeps: ({ search }) => ({
    segment: search.segment,
    run: search.run,
    theme: search.theme,
  }),
  loader: async ({ context, deps }) => {
    const [landscape, syntheticRuns] = await Promise.all([
      fetchCompetitiveLandscape({
        data: { segment: deps.segment, run: deps.run, theme: deps.theme },
      }),
      fetchSyntheticRuns(),
    ]);
    return { user: context.user, landscape, syntheticRuns };
  },
  component: Competitive,
});

type ViewMode = "chart" | "table";

function Competitive() {
  const { user, landscape, syntheticRuns } = Route.useLoaderData();
  const { segment, theme } = Route.useSearch();
  const {
    activeRunDate,
    runDates,
    themes,
    current,
    currentSovTotal,
    rankTrend,
    sovTrend,
    sovTotal,
    brandSov,
    brandSovTrend,
    brandSovRank,
    brandName,
  } = landscape;

  const themeLabel =
    theme === COMPETITIVE_THEME_ALL ? "all themes" : `theme: ${theme}`;
  // The x-axis for both trend charts is the run dates (ascending) — the same
  // order the SoV series points carry, so values line up column-for-column.
  const runOrder = rankTrend.map((p) => p.runDate);
  const focusIndex = runOrder.indexOf(activeRunDate ?? "");

  return (
    <main className="shell">
      <Nav
        active="competitive"
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
          <h1 className="comp__title">Competitive landscape</h1>
          {/* The cohort and its denominator, always labeled (spec §6/§7). */}
          <span className="comp__meta">
            cohort <span className="comp__cohort">others_present = true</span> ·{" "}
            {SEGMENT_LABEL[segment]} segment · {themeLabel}
            {current ? (
              <>
                {" "}
                · N ={" "}
                <span className="comp__den">
                  {count(current.rankDistribution.competitive)}
                </span>{" "}
                competitive results in run{" "}
                <span className="comp__rundate">{activeRunDate}</span>
              </>
            ) : activeRunDate ? (
              <> · no competitive results in run {activeRunDate}</>
            ) : null}
          </span>

          <div className="comp__controls">
            <div className="comp__segctl">
              {SEGMENTS.map((s) => (
                <Link
                  key={s}
                  from={Route.fullPath}
                  // biome-ignore lint/suspicious/noExplicitAny: search-updater preserves all params
                  search={(prev: any) => ({ ...prev, segment: s })}
                  className={
                    s === segment ? "comp__seg comp__seg--active" : "comp__seg"
                  }
                  aria-current={s === segment ? "true" : undefined}
                >
                  {SEGMENT_LABEL[s]}
                </Link>
              ))}
            </div>

            {/* Theme scope — only themes present in the competitive cohort under
                the current segment are offered. */}
            <ScopeSelect
              label="Theme"
              value={theme}
              options={[
                [COMPETITIVE_THEME_ALL, "All themes"],
                ...themes.map((t) => [t, t] as [string, string]),
              ]}
              param="theme"
            />

            {/* Focus run — drives the current-run leaderboard + the focus guide on
                the trend charts. The trends themselves always span every run. */}
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
        ) : rankTrend.length === 0 ? (
          <p className="shell__placeholder">
            No competitive results in the {SEGMENT_LABEL[segment]} segment
            {theme === COMPETITIVE_THEME_ALL ? "" : ` · ${theme}`}. Try another
            scope.
          </p>
        ) : (
          <>
            <RankSection
              current={current}
              trend={rankTrend}
              runOrder={runOrder}
              focusIndex={focusIndex}
            />
            <SovSection
              current={current}
              currentSovTotal={currentSovTotal}
              series={sovTrend}
              total={sovTotal}
              runOrder={runOrder}
              focusIndex={focusIndex}
              brandSov={brandSov}
              brandSovTrend={brandSovTrend}
              brandSovRank={brandSovRank}
              brandName={brandName}
            />
          </>
        )}
      </section>
    </main>
  );
}

// A labeled <select> that navigates by patching one search param, preserving the
// rest. Uses useNavigate bound to this route (`from`) — the same pattern as the
// scoreboard's run switcher.
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

function Legend({
  items,
  trailing,
}: {
  items: { label: string; color: string }[];
  trailing?: string;
}) {
  return (
    <div className="comp__legend">
      {items.map((it) => (
        <span key={it.label} className="comp__legenditem">
          <span className="comp__swatch" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
      {trailing ? <span className="comp__legendmore">{trailing}</span> : null}
    </div>
  );
}

// ── Horizontal bars (focused-run distributions) ──────────────────────────────

interface BarRow {
  label: string;
  share: number | null;
  color: string;
  meta: string;
  /** The brand's own row — emphasized and marked, never just recolored. */
  brand?: boolean;
}

function HBars({ rows }: { rows: BarRow[] }) {
  return (
    <div className="comp__hbars">
      {rows.map((r) => (
        <div
          className={r.brand ? "comp__hbar comp__hbar--brand" : "comp__hbar"}
          // Namespaced: the judge's competitor list can contain a string equal to
          // the brand name, and the two rows must stay distinct.
          key={`${r.brand ? "us:" : "c:"}${r.label}`}
        >
          {/* Only the name truncates; the "us" chip is a sibling that never
              shrinks, so an arbitrarily long brand_name can't ellipse the marker
              away and leave color as the only signal. */}
          <span className="comp__hbarlabel" title={r.label}>
            <span className="comp__hbarname">{r.label}</span>
            {r.brand && <span className="comp__us">{BRAND_MARKER}</span>}
          </span>
          <span className="comp__hbartrack">
            <span
              className="comp__hbarfill"
              style={{ width: `${(r.share ?? 0) * 100}%`, background: r.color }}
            />
          </span>
          <span className="comp__hbarval">
            {r.share === null ? "—" : pct(r.share)}
            <span className="comp__hbarmeta"> {r.meta}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Rank distribution ────────────────────────────────────────────────────────

function RankSection({
  current,
  trend,
  runOrder,
  focusIndex,
}: {
  current: CompetitivePoint | null;
  trend: RankTrendPoint[];
  runOrder: string[];
  focusIndex: number;
}) {
  const [view, setView] = useState<ViewMode>("chart");

  // Rank-share trend: one line per rank bucket, share = count / competitive per
  // run (null when a run has no competitive results → a gap, not a zero).
  const rankSeries: TrendSeries[] = BRAND_RANK_KEYS.map((k) => ({
    label: RANK_LABEL[k],
    color: RANK_COLOR[k],
    highlighted: true,
    values: trend.map((p) =>
      p.rankDistribution.competitive === 0
        ? null
        : p.rankDistribution.counts[k] / p.rankDistribution.competitive,
    ),
  }));

  return (
    <div className="comp__block">
      <div className="comp__blockhead">
        <h2 className="comp__blocktitle">Brand rank distribution</h2>
      </div>
      <p className="comp__blocknote">
        Where the brand ranks when competitors are present. Shares are over the
        competitive cohort (N).
      </p>

      {current && current.rankDistribution.competitive > 0 ? (
        <RankBars dist={current.rankDistribution} />
      ) : (
        <p className="themes__empty">
          No competitive results in the focused run.
        </p>
      )}

      <div className="comp__blockhead">
        <h3 className="comp__subtitle">Rank share over run dates</h3>
        <ViewToggle view={view} onChange={setView} />
      </div>
      {view === "chart" ? (
        <>
          <TrendChart
            series={rankSeries}
            xLabels={runOrder.map(shortDate)}
            xTooltipLabels={runOrder}
            focusIndex={focusIndex}
            format={pct}
            ariaLabel="Brand rank share over run dates"
          />
          <Legend
            items={BRAND_RANK_KEYS.map((k) => ({
              label: RANK_LABEL[k],
              color: RANK_COLOR[k],
            }))}
          />
        </>
      ) : (
        <RankTable trend={trend} focusRun={current?.runDate} />
      )}
    </div>
  );
}

function RankBars({ dist }: { dist: RankDistribution }) {
  return (
    <HBars
      rows={BRAND_RANK_KEYS.map((k) => ({
        label: RANK_LABEL[k],
        share:
          dist.competitive === 0 ? null : dist.counts[k] / dist.competitive,
        color: RANK_COLOR[k],
        meta: `${count(dist.counts[k])} of ${count(dist.competitive)}`,
      }))}
    />
  );
}

function RankTable({
  trend,
  focusRun,
}: {
  trend: RankTrendPoint[];
  focusRun?: string;
}) {
  return (
    <div className="comp__tablewrap">
      <table className="comp__table">
        <thead>
          <tr>
            <th>Run</th>
            <th className="comp__num">N</th>
            {BRAND_RANK_KEYS.map((k) => (
              <th key={k} className="comp__num">
                {RANK_LABEL[k]}
              </th>
            ))}
            <th className="comp__num">1st-place rate</th>
          </tr>
        </thead>
        <tbody>
          {trend.map((p) => {
            const d = p.rankDistribution;
            const active = p.runDate === focusRun;
            return (
              <tr
                key={p.runDate}
                className={active ? "comp__row comp__row--active" : "comp__row"}
              >
                <td className="comp__rundate">{p.runDate}</td>
                <td className="comp__num">{count(d.competitive)}</td>
                {BRAND_RANK_KEYS.map((k) => (
                  <td
                    key={k}
                    className="comp__num"
                    title={`${d.counts[k]} of ${d.competitive}`}
                  >
                    {pct(
                      d.competitive === 0 ? null : d.counts[k] / d.competitive,
                    )}
                  </td>
                ))}
                <td className="comp__num comp__num--key">
                  {pct(d.firstPlaceRate)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Share of voice ───────────────────────────────────────────────────────────

function SovSection({
  current,
  currentSovTotal,
  series,
  total,
  runOrder,
  focusIndex,
  brandSov,
  brandSovTrend,
  brandSovRank,
  brandName,
}: {
  current: CompetitivePoint | null;
  currentSovTotal: number;
  series: CompetitorSeries[];
  total: number;
  runOrder: string[];
  focusIndex: number;
  brandSov: BrandShareOfVoice | null;
  brandSovTrend: BrandSovPoint[];
  brandSovRank: number | null;
  brandName: string;
}) {
  const [view, setView] = useState<ViewMode>("chart");

  // Series are pre-sorted by total mentions desc; the first SOV_HIGHLIGHT_COUNT
  // are emphasized (colored), the rest form a dimmed context field. The counts
  // and labels below stay competitor-only — the brand is never a competitor and
  // never spends one of the capped slots.
  const highlightCount = Math.min(SOV_HIGHLIGHT_COUNT, series.length);
  const competitorSeries: TrendSeries[] = series.map((s, i) => ({
    label: s.competitor,
    color: SOV_PALETTE[i % SOV_PALETTE.length] as string,
    highlighted: i < highlightCount,
    values: s.points.map((p) => p.share),
  }));
  // The "(us)" suffix does double duty: it labels the line in the chart tooltip
  // and legend without relying on color, and it keeps the series key distinct
  // from a competitor the judge happened to name identically.
  const brandLabel = `${brandName} (${BRAND_MARKER})`;
  const brandSeries: TrendSeries = {
    label: brandLabel,
    color: BRAND_SOV,
    // Always highlighted, never dimmed — and appended last so it draws on top of
    // the competitor field rather than under it.
    highlighted: true,
    // Pinned in the crosshair tooltip: the tooltip caps its rows and sorts by
    // value, so an un-pinned brand line ranked outside the top rows would be
    // drawn but unreadable — exactly the question the feature exists to answer.
    pinned: true,
    values: brandSovTrend.map((p) => p.share),
  };
  const chartSeries: TrendSeries[] = [...competitorSeries, brandSeries];
  const dimmed = series.length - highlightCount;

  return (
    <div className="comp__block">
      <div className="comp__blockhead">
        <h2 className="comp__blocktitle">Share of voice</h2>
        <ViewToggle view={view} onChange={setView} />
      </div>
      <p className="comp__blocknote">
        Per competitor, the fraction of competitive results that mention them
        (mentioned=true rows only); denominator is the competitive cohort.
        Showing the top {series.length} of {count(total)} competitors
        {dimmed > 0 ? `; top ${highlightCount} highlighted` : ""}.{" "}
        <span className="comp__brandnote">
          {brandName} ({BRAND_MARKER}) is shown on that same denominator —
          mentioned=true over the competitive cohort, <em>not</em> the headline
          mention rate, whose denominator is the All cohort.
        </span>
      </p>

      {current && current.shareOfVoice.competitive > 0 ? (
        <SovLeaderboard
          competitors={current.shareOfVoice.competitors}
          competitive={current.shareOfVoice.competitive}
          total={currentSovTotal}
          runDate={current.runDate}
          brandSov={brandSov}
          brandSovRank={brandSovRank}
          brandName={brandName}
        />
      ) : (
        <p className="themes__empty">
          No competitor mentions in the focused run.
        </p>
      )}

      <h3 className="comp__subtitle">Share of voice over run dates</h3>
      {view === "chart" ? (
        <>
          <TrendChart
            series={chartSeries}
            xLabels={runOrder.map(shortDate)}
            xTooltipLabels={runOrder}
            focusIndex={focusIndex}
            format={pct}
            ariaLabel={`Share of voice over run dates — ${brandName} and competitors`}
          />
          <Legend
            items={[
              { label: brandLabel, color: BRAND_SOV },
              ...competitorSeries
                .filter((s) => s.highlighted)
                .map((s) => ({ label: s.label, color: s.color })),
            ]}
            trailing={dimmed > 0 ? `+ ${dimmed} more (dimmed)` : undefined}
          />
        </>
      ) : (
        <SovTable
          series={series}
          runOrder={runOrder}
          focusRun={current?.runDate}
          brandSovTrend={brandSovTrend}
          brandName={brandName}
        />
      )}
    </div>
  );
}

// The focused run's leaderboard: each competitor's share of that run's cohort,
// plus the brand's own share on the identical denominator. The brand is spliced
// into sorted position by its rank against the *full* competitor list — so it
// still renders (last) when its share falls below every competitor shown, and it
// never displaces one of the capped competitor rows.
function SovLeaderboard({
  competitors,
  competitive,
  total,
  runDate,
  brandSov,
  brandSovRank,
  brandName,
}: {
  competitors: { competitor: string; mentions: number; share: number | null }[];
  competitive: number;
  total: number;
  runDate: string;
  brandSov: BrandShareOfVoice | null;
  brandSovRank: number | null;
  brandName: string;
}) {
  const rows: BarRow[] = competitors.map((c) => ({
    label: c.competitor,
    share: c.share,
    color: SOV_BAR,
    meta: `${count(c.mentions)}`,
  }));
  if (brandSov) {
    const at = Math.min(
      brandSovRank === null ? rows.length : brandSovRank - 1,
      rows.length,
    );
    rows.splice(at, 0, {
      label: brandName,
      share: brandSov.share,
      color: BRAND_SOV,
      meta: `${count(brandSov.mentions)}`,
      brand: true,
    });
  }
  return (
    <>
      <p className="comp__leadlabel">
        Run {runDate} · share of N = {count(competitive)}
        {total > competitors.length
          ? ` · top ${competitors.length} of ${count(total)} competitors`
          : ""}
        {brandSov ? ` + ${brandName} (${BRAND_MARKER})` : ""}
        {brandSov && brandSovRank !== null
          ? ` · ${brandName} ranks #${brandSovRank} against ${count(
              total,
            )} competitors by share of voice`
          : ""}
      </p>
      <HBars rows={rows} />
    </>
  );
}

// The table alternative — a competitor × run matrix of shares (the many-series
// view the chart can't keep legible).
function SovTable({
  series,
  runOrder,
  focusRun,
  brandSovTrend,
  brandName,
}: {
  series: CompetitorSeries[];
  runOrder: string[];
  focusRun?: string;
  brandSovTrend: BrandSovPoint[];
  brandName: string;
}) {
  const cellClass = (runDate: string) =>
    runDate === focusRun ? "comp__num comp__num--focus" : "comp__num";
  return (
    <div className="comp__tablewrap">
      <table className="comp__table">
        <thead>
          <tr>
            <th>Competitor</th>
            {runOrder.map((d) => (
              <th
                key={d}
                className={
                  d === focusRun ? "comp__num comp__num--focus" : "comp__num"
                }
              >
                {shortDate(d)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* The brand is pinned first — it's the row every competitor row is
              read against, and it must never be trimmed by the competitor cap. */}
          <tr className="comp__row comp__row--brand">
            <td className="comp__name">
              {brandName}
              <span className="comp__us">{BRAND_MARKER}</span>
            </td>
            {brandSovTrend.map((p) => (
              <td
                key={p.runDate}
                className={cellClass(p.runDate)}
                title={`${p.mentions} mention${p.mentions === 1 ? "" : "s"}`}
              >
                {pct(p.share)}
              </td>
            ))}
          </tr>
          {series.map((s) => (
            <tr key={s.competitor} className="comp__row">
              <td className="comp__name">{s.competitor}</td>
              {s.points.map((p) => (
                <td
                  key={p.runDate}
                  className={cellClass(p.runDate)}
                  title={`${p.mentions} mention${p.mentions === 1 ? "" : "s"}`}
                >
                  {pct(p.share)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
