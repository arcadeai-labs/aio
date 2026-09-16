import type {
  CohortFunnel,
  Delta,
  HeadlineDeltas,
  ProviderMetricsRow,
  RowDeltas,
  RunProvenance,
  Scoreboard,
  Segment,
  ThemeMetricsRow,
} from "@aio/db";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { motion, useReducedMotion } from "framer-motion";
import { type ReactNode, useEffect } from "react";
import { AnimatedNumber } from "../components/AnimatedNumber";
import { Nav } from "../components/Nav";
import { resolveUser } from "../lib/route-guard";
import { fetchScoreboard } from "../lib/scoreboard";
import {
  TABLE_DELTA,
  count,
  deltaClass,
  deltaCount,
  deltaPts,
  deltaPtsLabeled,
  deltaScore,
  neutralDeltaClass,
  newDeltaClass,
  pct,
  score,
} from "../lib/scoreboard-view";
import { SEGMENTS, SEGMENT_LABEL, toSegment } from "../lib/segments";

// URL state for the scoreboard's composable controls. The segment selector and
// the two breakdown toggles (by-theme, by-provider) plus the active run all live
// in the URL so any scoped view (e.g. run 2026-05-11 → Unbranded → by provider)
// is shareable and survives reload. Unknown values coerce to defaults so a
// hand-typed URL can't wedge the page; `run` is left to the server to validate
// against the real ingested-run list (an unknown date falls back to the latest).
interface ScoreboardSearch {
  segment: Segment;
  byTheme: boolean;
  byProvider: boolean;
  run?: string;
}

function validateSearch(search: Record<string, unknown>): ScoreboardSearch {
  return {
    segment: toSegment(search.segment),
    byTheme: search.byTheme === true || search.byTheme === "true",
    byProvider: search.byProvider === true || search.byProvider === "true",
    run: typeof search.run === "string" ? search.run : undefined,
  };
}

export const Route = createFileRoute("/")({
  validateSearch,
  beforeLoad: resolveUser,
  // Segment *and* run change what the server computes, so both are loader deps.
  // The byTheme/byProvider toggles only reveal already-fetched rows, so they stay
  // out of the deps (no refetch on toggle).
  loaderDeps: ({ search }) => ({ segment: search.segment, run: search.run }),
  loader: async ({ context, deps }) => ({
    user: context.user,
    scoreboard: await fetchScoreboard({
      data: { segment: deps.segment, run: deps.run },
    }),
  }),
  component: Home,
});

// Value/delta formatters live in ../lib/scoreboard-view (issue #28) so the
// headline pill and the three breakdown tables render a delta identically.

// ── Table delta cells (issue #40) ────────────────────────────────────────────
//
// The headline's `.score__delta` pill is too heavy repeated down a dense table,
// so table cells use the compact `.themes__delta` variant — same semantic colors,
// same tabular numerals, so the deltas align as a column under their values.
//
// Three states, deliberately distinguished:
//   - no prior run  → nothing rendered at all (the meta line explains why)
//   - new key       → marked once, on the row's name cell (never per column, and
//                     never "—", which would read as a missing value)
//   - real delta    → the signed value, colored by its (already polarity-
//                     corrected) direction

/** One rate/score cell's delta, under its value. */
function CellDelta({
  deltas,
  pick,
  format,
}: {
  deltas: RowDeltas;
  pick: (m: HeadlineDeltas) => Delta;
  format: (d: Delta) => string;
}) {
  if (deltas.kind !== "delta") return null;
  const d = pick(deltas.metrics);
  return <span className={deltaClass(d, TABLE_DELTA)}>{format(d)}</span>;
}

/** A count column's delta — signed but **neutral**: a shifting denominator
 * explains a rate move, it isn't itself good or bad. */
function CountDelta({ delta }: { delta: Delta | null }) {
  if (!delta) return null;
  return <span className={neutralDeltaClass()}>{deltaCount(delta)}</span>;
}

/** The row-level "new in this run" marker. */
function NewMarker({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className={newDeltaClass()} title="New in this run — no prior row">
      new
    </span>
  );
}

// Keys that existed in the prior run and are gone from the active one get no
// phantom row — but their disappearance is itself news, so it's noted in the
// panel's sub-line.
function droppedNote(n: number, priorRunDate: string | undefined): string {
  if (n === 0 || !priorRunDate) return "";
  return ` · ${count(n)} dropped since ${priorRunDate}`;
}

/** A numeric column header carrying its delta *unit*, so the cells below can stay
 * narrow (spec §9: no "pts" repeated in every cell). */
function NumHead({
  label,
  unit,
  showDeltas,
}: {
  label: string;
  unit: string;
  showDeltas: boolean;
}) {
  return (
    <th
      className="themes__num"
      title={showDeltas ? `Δ vs the prior run, in ${unit}` : undefined}
    >
      {label}
      {showDeltas && <span className="themes__unit">Δ {unit}</span>}
    </th>
  );
}

// Format with a fixed locale + timezone (UTC). The freshness strip renders during
// SSR, so a runtime-default locale/timezone here would differ server vs client and
// trip a hydration mismatch — pin both and label the zone so the value is
// deterministic and unambiguous.
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  })} UTC`;
}

// One headline cell. The value counts up on a run switch (AnimatedNumber); the
// card itself rises in with a short, staggered delay on mount. `index` orders the
// stagger so the four cells cascade left-to-right, top-to-bottom.
function Metric({
  name,
  value,
  format,
  delta,
  deltaText,
  cohort,
  index,
}: {
  name: string;
  value: number | null;
  format: (n: number) => string;
  delta: Delta;
  deltaText: string;
  cohort: string;
  index: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className="metric"
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay: index * 0.04, ease: "easeOut" }}
    >
      <div className="metric__head">
        <span className="metric__name">{name}</span>
        <span className={deltaClass(delta)}>{deltaText}</span>
      </div>
      <AnimatedNumber className="metric__value" value={value} format={format} />
      <p className="metric__cohort">{cohort}</p>
    </motion.div>
  );
}

// Run switcher (issue #8) — the dominant scoreboard control. Steps run-to-run by
// *actual run date* (not calendar weeks): prev/next jump to the adjacent ingested
// run, and the dropdown jumps to any run. `runDates` is newest-first, so the
// older run sits at a higher index and the newer run at a lower one. Every
// navigation preserves the rest of the URL state (segment, toggles) via the
// search-updater form, so switching runs keeps the active scope.
function RunSwitcher({
  runDates,
  active,
}: {
  runDates: string[];
  active: string;
}) {
  const navigate = useNavigate({ from: Route.fullPath });
  const idx = runDates.indexOf(active);
  const olderDate = idx >= 0 ? (runDates[idx + 1] ?? null) : null;
  const newerDate = idx > 0 ? (runDates[idx - 1] ?? null) : null;
  const position = idx >= 0 ? idx + 1 : 1;

  return (
    <div className="runsw">
      {olderDate ? (
        <Link
          to="/"
          // biome-ignore lint/suspicious/noExplicitAny: search-updater preserves all params
          search={(prev: any) => ({ ...prev, run: olderDate })}
          className="runsw__step"
          aria-label="Older run"
          title={`Older run (${olderDate})`}
        >
          ‹ Older
        </Link>
      ) : (
        <span
          className="runsw__step runsw__step--disabled"
          aria-disabled="true"
        >
          ‹ Older
        </span>
      )}
      <select
        className="runsw__select"
        value={active}
        aria-label="Select run date"
        onChange={(e) => {
          void navigate({
            // biome-ignore lint/suspicious/noExplicitAny: search-updater preserves all params
            search: (prev: any) => ({ ...prev, run: e.target.value }),
          });
        }}
      >
        {runDates.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>
      {newerDate ? (
        <Link
          to="/"
          // biome-ignore lint/suspicious/noExplicitAny: search-updater preserves all params
          search={(prev: any) => ({ ...prev, run: newerDate })}
          className="runsw__step"
          aria-label="Newer run"
          title={`Newer run (${newerDate})`}
        >
          Newer ›
        </Link>
      ) : (
        <span
          className="runsw__step runsw__step--disabled"
          aria-disabled="true"
        >
          Newer ›
        </span>
      )}
      <span className="runsw__pos">
        run {position} of {runDates.length}
      </span>
    </div>
  );
}

// Per-run freshness/provenance (issue #8) — read from the active run's
// `ingest_runs` row. Surfaces ingested-at + row counts and makes partial/missing
// runs detectable: a non-"ok" status or any orphaned verdicts warns. The full
// per-run table lives on the /runs page; this is the active run's strip. The row
// counts are the run's ingest totals (whole run, not segment-scoped — unlike the
// headline above), so they're labelled "Total" to avoid reading as segment counts.
function Freshness({ provenance }: { provenance: RunProvenance | null }) {
  if (!provenance) {
    return (
      <div className="fresh fresh--warn">
        <span className="fresh__title">Freshness</span>
        <span className="fresh__note">
          No ingest record for this run — provenance unavailable.
        </span>
      </div>
    );
  }
  // Results that never produced a verdict — exactly the errored provider calls
  // (every error-free result carries a verdict). A run with such a gap is partial
  // even though the *ingest* status is "ok": ingest status tracks whether the
  // files were read cleanly, not whether every provider call succeeded.
  const missingVerdicts = Math.max(
    0,
    provenance.resultCount - provenance.verdictCount,
  );
  const partial =
    provenance.status !== "ok" ||
    provenance.orphanVerdictCount > 0 ||
    missingVerdicts > 0;
  // The pill says "ok" only for a genuinely complete run; otherwise it shows the
  // ingest status when that's the problem, else "partial" for a verdict gap.
  const statusLabel =
    provenance.status !== "ok" ? provenance.status : partial ? "partial" : "ok";
  return (
    <div className={partial ? "fresh fresh--warn" : "fresh"}>
      <span className="fresh__title">Freshness</span>
      <span className="fresh__item">
        <span className="fresh__label">Ingested</span>
        <span className="fresh__val">
          {formatTimestamp(provenance.ingestedAt)}
        </span>
      </span>
      <span className="fresh__item">
        <span className="fresh__label">Total results</span>
        <span className="fresh__val">{count(provenance.resultCount)}</span>
      </span>
      <span className="fresh__item">
        <span className="fresh__label">Total verdicts</span>
        <span className="fresh__val">{count(provenance.verdictCount)}</span>
      </span>
      {missingVerdicts > 0 && (
        <span className="fresh__item">
          <span className="fresh__label">No verdict</span>
          <span className="fresh__val fresh__val--warn">
            {count(missingVerdicts)}
          </span>
        </span>
      )}
      {provenance.orphanVerdictCount > 0 && (
        <span className="fresh__item">
          <span className="fresh__label">Orphans</span>
          <span className="fresh__val fresh__val--warn">
            {count(provenance.orphanVerdictCount)}
          </span>
        </span>
      )}
      <span
        className={
          partial
            ? "fresh__status fresh__status--warn"
            : "fresh__status fresh__status--ok"
        }
      >
        {statusLabel}
      </span>
    </div>
  );
}

function Funnel({ funnel }: { funnel: CohortFunnel }) {
  return (
    <div className="funnel">
      <span className="funnel__title">Cohort funnel</span>
      <ol className="funnel__list">
        <li className="funnel__step">
          <span className="funnel__label">All</span>
          <span className="funnel__cond">error IS NULL</span>
          <span className="funnel__count">{count(funnel.all)}</span>
        </li>
        <li className="funnel__step funnel__step--child">
          <span className="funnel__label">Mentioned</span>
          <span className="funnel__cond">mentioned = true</span>
          <span className="funnel__count">{count(funnel.mentioned)}</span>
        </li>
        <li className="funnel__step funnel__step--grandchild">
          <span className="funnel__label">Competitive</span>
          <span className="funnel__cond">others_present = true</span>
          <span className="funnel__count">{count(funnel.competitive)}</span>
        </li>
        <li className="funnel__step funnel__step--parallel">
          <span className="funnel__label">Cited</span>
          <span className="funnel__cond">owned_cited = true</span>
          <span className="funnel__count">{count(funnel.cited)}</span>
        </li>
      </ol>
    </div>
  );
}

// Coverage / errors, with each row's WoW delta. The error-rate delta's polarity is
// **inverted upstream** (metrics.ts `invertDirection`): here lower is better, so a
// rising error rate must render red even though its sign is positive. The two
// count columns stay neutral.
function Coverage({
  coverage,
  priorRunDate,
}: {
  coverage: Scoreboard["coverage"];
  priorRunDate: string | null;
}) {
  if (coverage.length === 0) return null;
  const totalErrored = coverage.reduce((s, c) => s + c.errored, 0);
  const showDeltas = priorRunDate !== null;
  return (
    <div className="coverage">
      <div className="coverage__head">
        <span className="coverage__title">Coverage / errors</span>
        <span className="coverage__note">
          {totalErrored === 0
            ? "All providers fully covered — no errored results."
            : "Errored results are excluded from every rate above."}
          {showDeltas ? ` Δ vs ${priorRunDate}; error rate up = worse.` : ""}
        </span>
      </div>
      <table className="coverage__table">
        <thead>
          <tr>
            <th>Provider</th>
            <th className="coverage__num">
              Attempted
              {showDeltas && <span className="themes__unit">Δ n</span>}
            </th>
            <th className="coverage__num">
              Errored
              {showDeltas && <span className="themes__unit">Δ n</span>}
            </th>
            <th className="coverage__num">
              Error rate
              {showDeltas && <span className="themes__unit">Δ pts</span>}
            </th>
          </tr>
        </thead>
        <tbody>
          {coverage.map((c) => (
            <tr key={c.provider}>
              <td className="coverage__provider">
                {c.provider}
                <NewMarker show={c.deltas.kind === "new"} />
              </td>
              <td className="coverage__num">
                <span className="themes__val">{count(c.attempted)}</span>
                <CountDelta
                  delta={c.deltas.kind === "delta" ? c.deltas.attempted : null}
                />
              </td>
              <td className="coverage__num">
                <span className="themes__val">{count(c.errored)}</span>
                <CountDelta
                  delta={c.deltas.kind === "delta" ? c.deltas.errored : null}
                />
              </td>
              <td
                className={
                  c.errored > 0
                    ? "coverage__num coverage__num--warn"
                    : "coverage__num"
                }
              >
                <span className="themes__val">{pct(c.errorRate)}</span>
                {c.deltas.kind === "delta" && (
                  <span
                    className={deltaClass(c.deltas.errorRate, TABLE_DELTA)}
                    title="Change in error rate vs the prior run — lower is better"
                  >
                    {deltaPts(c.deltas.errorRate)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Segment selector — re-scopes the whole scoreboard (PRD story #8). Each option
// is a Link that sets `segment` while preserving every other URL param (run +
// both toggles) via the search-updater form, so segment composes with run and
// theme and the choice lands in URL state.
function SegmentSelector({ segment }: { segment: Segment }) {
  return (
    <div className="segctl">
      {SEGMENTS.map((s) => (
        <Link
          key={s}
          to="/"
          // biome-ignore lint/suspicious/noExplicitAny: search-updater preserves all params
          search={(prev: any) => ({ ...prev, segment: s })}
          className={
            s === segment ? "segctl__opt segctl__opt--active" : "segctl__opt"
          }
          aria-current={s === segment ? "true" : undefined}
        >
          {SEGMENT_LABEL[s]}
        </Link>
      ))}
    </div>
  );
}

// Per-provider headline breakdown (issue #8) — the pooled headline expanded one
// level down, scoped to the active segment. Each row is a full headline computed
// over that provider's slice of the scoped rows; the All count anchors every rate
// to its denominator. The provider name is the drill-down entry point (issue #9):
// clicking it opens that run × provider's prompt-result list, carrying the active
// run and segment so the list lands in the same scope.
function ProviderBreakdown({
  providers,
  runDate,
  segment,
  showDeltas,
}: {
  providers: ProviderMetricsRow[];
  runDate: string;
  segment: Segment;
  showDeltas: boolean;
}) {
  if (providers.length === 0) {
    return (
      <p className="themes__empty">No provider results in this segment.</p>
    );
  }
  return (
    <table className="themes__table">
      <thead>
        <tr>
          <th>Provider</th>
          <NumHead label="All" unit="n" showDeltas={showDeltas} />
          <NumHead label="Mention" unit="pts" showDeltas={showDeltas} />
          <NumHead label="Avg acc." unit="score" showDeltas={showDeltas} />
          <NumHead label="Owned-cite" unit="pts" showDeltas={showDeltas} />
          <NumHead label="1st-place" unit="pts" showDeltas={showDeltas} />
        </tr>
      </thead>
      <tbody>
        {providers.map((p) => (
          <tr key={p.provider}>
            <td className="themes__name">
              <Link
                to="/run/$run/provider/$provider"
                params={{ run: runDate, provider: p.provider }}
                search={{ segment }}
                className="themes__drill"
              >
                {p.provider} ›
              </Link>
              <NewMarker show={p.deltas.kind === "new"} />
            </td>
            <td className="themes__num">
              <span className="themes__val">{count(p.funnel.all)}</span>
              <CountDelta
                delta={p.deltas.kind === "delta" ? p.deltas.all : null}
              />
            </td>
            <td className="themes__num">
              <span className="themes__val">{pct(p.mentionRate.rate)}</span>
              <CellDelta
                deltas={p.deltas}
                pick={(m) => m.mentionRate}
                format={deltaPts}
              />
            </td>
            <td className="themes__num">
              <span className="themes__val">{score(p.avgAccuracy.mean)}</span>
              <CellDelta
                deltas={p.deltas}
                pick={(m) => m.avgAccuracy}
                format={deltaScore}
              />
            </td>
            <td className="themes__num">
              <span className="themes__val">
                {pct(p.ownedCitationRate.rate)}
              </span>
              <CellDelta
                deltas={p.deltas}
                pick={(m) => m.ownedCitationRate}
                format={deltaPts}
              />
            </td>
            <td className="themes__num">
              <span className="themes__val">{pct(p.firstPlaceRate.rate)}</span>
              <CellDelta
                deltas={p.deltas}
                pick={(m) => m.firstPlaceRate}
                format={deltaPts}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Per-theme cross-tab within the current segment (issue #7). Each row is a full
// headline computed over that theme's slice of the scoped rows; the All count
// anchors every rate to its denominator.
function ThemeBreakdown({
  themes,
  showDeltas,
}: {
  themes: ThemeMetricsRow[];
  showDeltas: boolean;
}) {
  if (themes.length === 0) {
    return <p className="themes__empty">No themed results in this segment.</p>;
  }
  return (
    <table className="themes__table">
      <thead>
        <tr>
          <th>Theme</th>
          <NumHead label="All" unit="n" showDeltas={showDeltas} />
          <NumHead label="Mention" unit="pts" showDeltas={showDeltas} />
          <NumHead label="Avg acc." unit="score" showDeltas={showDeltas} />
          <NumHead label="Owned-cite" unit="pts" showDeltas={showDeltas} />
          <NumHead label="1st-place" unit="pts" showDeltas={showDeltas} />
        </tr>
      </thead>
      <tbody>
        {themes.map((t) => (
          <tr key={t.theme ?? "__none"}>
            <td className="themes__name">
              {t.theme ?? "Uncategorized"}
              <NewMarker show={t.deltas.kind === "new"} />
            </td>
            <td className="themes__num">
              <span className="themes__val">{count(t.funnel.all)}</span>
              <CountDelta
                delta={t.deltas.kind === "delta" ? t.deltas.all : null}
              />
            </td>
            <td className="themes__num">
              <span className="themes__val">{pct(t.mentionRate.rate)}</span>
              <CellDelta
                deltas={t.deltas}
                pick={(m) => m.mentionRate}
                format={deltaPts}
              />
            </td>
            <td className="themes__num">
              <span className="themes__val">{score(t.avgAccuracy.mean)}</span>
              <CellDelta
                deltas={t.deltas}
                pick={(m) => m.avgAccuracy}
                format={deltaScore}
              />
            </td>
            <td className="themes__num">
              <span className="themes__val">
                {pct(t.ownedCitationRate.rate)}
              </span>
              <CellDelta
                deltas={t.deltas}
                pick={(m) => m.ownedCitationRate}
                format={deltaPts}
              />
            </td>
            <td className="themes__num">
              <span className="themes__val">{pct(t.firstPlaceRate.rate)}</span>
              <CellDelta
                deltas={t.deltas}
                pick={(m) => m.firstPlaceRate}
                format={deltaPts}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// A revealable breakdown panel — shared chrome for the by-provider and by-theme
// expansions. The toggle flips one boolean in URL state (preserving the rest),
// and the body is already-fetched data so toggling never refetches.
function BreakdownPanel({
  title,
  sub,
  open,
  toggleKey,
  openLabel,
  closeLabel,
  children,
}: {
  title: string;
  sub: string;
  open: boolean;
  toggleKey: "byTheme" | "byProvider";
  openLabel: string;
  closeLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="themes">
      <div className="themes__head">
        <span className="themes__title">{title}</span>
        <span className="themes__sub">{sub}</span>
        <Link
          to="/"
          // biome-ignore lint/suspicious/noExplicitAny: search-updater preserves all params
          search={(prev: any) => ({ ...prev, [toggleKey]: !open })}
          // The breakdown reveals in place; without this, Router's default
          // scroll-to-top on navigation yanks the page to the top (jarring on
          // mobile, where the toggle is far down the scroll).
          resetScroll={false}
          className={
            open ? "themes__toggle themes__toggle--on" : "themes__toggle"
          }
          aria-pressed={open}
        >
          {open ? closeLabel : openLabel}
        </Link>
      </div>
      {open && children}
    </div>
  );
}

function Headline({
  scoreboard,
  byTheme,
  byProvider,
}: {
  scoreboard: Scoreboard;
  byTheme: boolean;
  byProvider: boolean;
}) {
  const {
    segment,
    runDates,
    active,
    prior,
    deltas,
    coverage,
    providers,
    themes,
    dropped,
    provenance,
  } = scoreboard;
  // With no prior run there is nothing to compare, so no delta affordance is
  // drawn anywhere — the meta line below already says why.
  const showDeltas = prior !== null;

  if (!active) {
    return (
      <p className="shell__placeholder">
        No runs ingested yet. Run <code>bun run ingest</code> from the pipeline
        laptop, then this scoreboard lights up. See{" "}
        <Link to="/runs" className="shell__link">
          ingested runs
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="score">
      <div className="score__meta">
        <span className="score__runlabel">Run</span>
        <span className="score__rundate">{active.runDate}</span>
        <span className="score__wow">
          {prior ? (
            <>
              WoW vs <span className="score__rundate">{prior.runDate}</span>
            </>
          ) : (
            "Earliest ingested run — no prior to compare."
          )}
        </span>
        <SegmentSelector segment={segment} />
      </div>

      <div className="score__controls">
        <RunSwitcher runDates={runDates} active={active.runDate} />
        <Freshness provenance={provenance} />
      </div>

      <div className="score__grid">
        <Metric
          name="Mention rate"
          value={active.mentionRate.rate}
          format={pct}
          index={0}
          delta={deltas.mentionRate}
          deltaText={deltaPtsLabeled(deltas.mentionRate)}
          cohort={`${count(active.mentionRate.numerator)} of ${count(
            active.mentionRate.denominator,
          )} · All (error-free, pooled)`}
        />
        <Metric
          name="Avg accuracy"
          value={active.avgAccuracy.mean}
          format={score}
          index={1}
          delta={deltas.avgAccuracy}
          deltaText={deltaScore(deltas.avgAccuracy)}
          cohort={`mean 1–5 over ${count(
            active.avgAccuracy.count,
          )} · Mentioned cohort`}
        />
        <Metric
          name="Owned-citation rate"
          value={active.ownedCitationRate.rate}
          format={pct}
          index={2}
          delta={deltas.ownedCitationRate}
          deltaText={deltaPtsLabeled(deltas.ownedCitationRate)}
          cohort={`${count(active.ownedCitationRate.numerator)} of ${count(
            active.ownedCitationRate.denominator,
          )} · All (error-free)`}
        />
        <Metric
          name="1st-place rate"
          value={active.firstPlaceRate.rate}
          format={pct}
          index={3}
          delta={deltas.firstPlaceRate}
          deltaText={deltaPtsLabeled(deltas.firstPlaceRate)}
          cohort={`${count(active.firstPlaceRate.numerator)} of ${count(
            active.firstPlaceRate.denominator,
          )} · Competitive (others_present)`}
        />
      </div>

      <Funnel funnel={active.funnel} />
      <Coverage coverage={coverage} priorRunDate={prior?.runDate ?? null} />

      <BreakdownPanel
        title="Provider breakdown"
        sub={`${SEGMENT_LABEL[segment]} segment × provider${droppedNote(
          dropped.providers,
          prior?.runDate,
        )}`}
        open={byProvider}
        toggleKey="byProvider"
        openLabel="Break down by provider"
        closeLabel="Hide breakdown"
      >
        <ProviderBreakdown
          providers={providers}
          runDate={active.runDate}
          segment={segment}
          showDeltas={showDeltas}
        />
      </BreakdownPanel>

      <BreakdownPanel
        title="Theme breakdown"
        sub={`${SEGMENT_LABEL[segment]} segment × theme${droppedNote(
          dropped.themes,
          prior?.runDate,
        )}`}
        open={byTheme}
        toggleKey="byTheme"
        openLabel="Break down by theme"
        closeLabel="Hide breakdown"
      >
        <ThemeBreakdown themes={themes} showDeltas={showDeltas} />
      </BreakdownPanel>

      <p className="score__footnote">
        Per-run freshness and row counts for every run on the{" "}
        <Link to="/runs" className="shell__link">
          runs
        </Link>{" "}
        page.
      </p>
    </div>
  );
}

function Home() {
  const { user, scoreboard } = Route.useLoaderData();
  const search = Route.useSearch();
  const { byTheme, byProvider } = search;
  const navigate = useNavigate({ from: Route.fullPath });
  const activeDate = scoreboard.active?.runDate;
  // If the URL asked for a run the server couldn't honor (unknown/old date → it
  // fell back to the latest), normalize `?run=` to the run actually shown so the
  // address bar and the run switcher agree. replace: this is a correction, not a
  // navigation, so it shouldn't add a history entry.
  useEffect(() => {
    if (search.run && activeDate && search.run !== activeDate) {
      void navigate({
        // biome-ignore lint/suspicious/noExplicitAny: search-updater preserves all params
        search: (prev: any) => ({ ...prev, run: activeDate }),
        replace: true,
      });
    }
  }, [search.run, activeDate, navigate]);
  return (
    <main className="shell">
      <Nav active="scoreboard" segment={search.segment} email={user?.email} />
      <section className="shell__body shell__body--top">
        <Headline
          scoreboard={scoreboard}
          byTheme={byTheme}
          byProvider={byProvider}
        />
      </section>
    </main>
  );
}
