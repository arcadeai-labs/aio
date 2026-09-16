import type { Segment } from "@aio/db";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Nav } from "../components/Nav";
import { TrajectoryGrid } from "../components/TrajectoryGrid";
import { fetchPromptTrajectory } from "../lib/prompt";
import { resolveUser } from "../lib/route-guard";
import { SEGMENT_LABEL, toSegment } from "../lib/segments";
import {
  DEFAULT_TRAJECTORY_METRIC,
  TRAJECTORY_METRICS,
  type TrajectoryMetric,
} from "../lib/trajectory-view";

// The segment the analyst was scoped to, threaded through so the back-links
// (to /prompts and into result-detail) return to the same scope. A prompt belongs
// to one branded_type, so segment is context, not a data filter here.
interface PromptSearch {
  segment: Segment;
}

function validateSearch(search: Record<string, unknown>): PromptSearch {
  return { segment: toSegment(search.segment) };
}

export const Route = createFileRoute("/prompt/$promptId")({
  validateSearch,
  beforeLoad: resolveUser,
  loader: async ({ context, params }) => ({
    user: context.user,
    view: await fetchPromptTrajectory({
      data: { promptId: params.promptId },
    }),
  }),
  component: PromptTrajectoryView,
});

function PromptTrajectoryView() {
  const { user, view } = Route.useLoaderData();
  const { segment } = Route.useSearch();
  const [metric, setMetric] = useState<TrajectoryMetric>(
    DEFAULT_TRAJECTORY_METRIC,
  );

  const { found, text, theme, brandedType, location, runDates, providers } =
    view;

  return (
    <main className="shell">
      <Nav active="prompts" segment={segment} email={user?.email} />

      <section className="comp">
        {!found ? (
          <p className="shell__placeholder">Prompt not found.</p>
        ) : (
          <>
            <div className="comp__head">
              <div className="comp__crumb">
                <Link
                  to="/prompts"
                  search={{ segment, theme: "all" }}
                  className="shell__link"
                >
                  ← Prompts
                </Link>
              </div>
              <h1 className="comp__title">{text}</h1>
              <span className="comp__meta">
                theme{" "}
                <span className="comp__cohort">{theme ?? "Uncategorized"}</span>{" "}
                · segment{" "}
                <span className="comp__cohort">
                  {brandedType
                    ? (SEGMENT_LABEL[brandedType as Segment] ?? brandedType)
                    : "—"}
                </span>
                {location ? (
                  <>
                    {" "}
                    · location <span className="comp__cohort">{location}</span>
                  </>
                ) : null}{" "}
                · provider × run over {runDates.length} runs · absent runs are
                gaps, not zeros
              </span>

              <div className="comp__controls">
                <div className="comp__toggle">
                  {TRAJECTORY_METRICS.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      className={
                        m.key === metric.key
                          ? "comp__tog comp__tog--on"
                          : "comp__tog"
                      }
                      onClick={() => setMetric(m)}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {providers.length === 0 ? (
              <p className="shell__placeholder">
                No results recorded for this prompt yet.
              </p>
            ) : (
              <div className="comp__block">
                <div className="comp__blockhead">
                  <h2 className="comp__blocktitle">
                    {metric.label} · provider × run
                  </h2>
                </div>
                <p className="comp__blocknote">
                  One row per provider, one column per run (oldest → newest).
                  Each cell links to that result's detail; an empty cell is a
                  run where the prompt was absent — a gap, never a zero.
                </p>
                <TrajectoryGrid
                  providers={providers}
                  runDates={runDates}
                  metric={metric}
                  segment={segment}
                />
                <MetricLegend metric={metric} />
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

// A metric-aware legend for the heatmap colors. Accuracy shows its 1–5 ramp; the
// binary metrics show on/off plus the shared absent (gap) state.
function MetricLegend({ metric }: { metric: TrajectoryMetric }) {
  if (metric.key === "accuracy") {
    return (
      <div className="grid__legend">
        <span className="grid__legendlabel">Accuracy</span>
        {[1, 2, 3, 4, 5].map((s) => (
          <span key={s} className="grid__legenditem">
            <span className={`grid__swatch grid__swatch--acc${s}`} />
            {s}
          </span>
        ))}
        <span className="grid__legenditem">
          <span className="grid__swatch grid__swatch--off" />
          not mentioned
        </span>
        <span className="grid__legenditem">
          <span className="grid__swatch grid__swatch--gap" />
          absent
        </span>
      </div>
    );
  }
  const onClass =
    metric.key === "mentioned"
      ? "grid__swatch--mention"
      : "grid__swatch--cited";
  const onLabel = metric.key === "mentioned" ? "mentioned" : "owned-cited";
  return (
    <div className="grid__legend">
      <span className="grid__legenditem">
        <span className={`grid__swatch ${onClass}`} />
        {onLabel}
      </span>
      <span className="grid__legenditem">
        <span className="grid__swatch grid__swatch--off" />
        no
      </span>
      <span className="grid__legenditem">
        <span className="grid__swatch grid__swatch--gap" />
        absent
      </span>
    </div>
  );
}
