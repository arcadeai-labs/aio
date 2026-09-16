// Client-safe constants + formatters for the prompt-trajectory pages (issue #13).
// Like segments.ts / competitive-view.ts, this imports nothing at runtime from
// @aio/db — pulling a runtime value from @aio/db drags the Postgres driver into
// the browser bundle (it throws on load without DATABASE_URL), breaking hydration
// of the whole route. So the presentational constants live here, client-side.

import type { TrajectoryCell } from "@aio/db";

/** "All themes" sentinel — must match the server's PROMPT_THEME_ALL. */
export const PROMPT_THEME_ALL = "all";

/**
 * The metrics a trajectory grid can color by. The data is ordinal/binary, not
 * continuous, so the views render it as a heatmap (not a line chart): `value`
 * maps a cell to a plottable number — 0/1 for the binary metrics, 1–5 for
 * accuracy — or null for "present but no value" (e.g. accuracy when the brand
 * wasn't mentioned). `binary` drives the cell glyph (✓ vs a score).
 */
export interface TrajectoryMetric {
  key: "accuracy" | "mentioned" | "ownedCited";
  label: string;
  binary: boolean;
  /** Cell → value, or null (no value for this metric / a gap). */
  value: (cell: TrajectoryCell) => number | null;
}

export const TRAJECTORY_METRICS: readonly TrajectoryMetric[] = [
  {
    key: "accuracy",
    label: "Accuracy (1–5)",
    binary: false,
    // Accuracy only exists when mentioned; otherwise it's a gap, not a 0.
    value: (c) => (c.hasError ? null : c.accuracyScore),
  },
  {
    key: "mentioned",
    label: "Mentioned",
    binary: true,
    value: (c) =>
      c.hasError || c.mentioned == null ? null : c.mentioned ? 1 : 0,
  },
  {
    key: "ownedCited",
    label: "Owned-cited",
    binary: true,
    value: (c) =>
      c.hasError || c.ownedCited == null ? null : c.ownedCited ? 1 : 0,
  },
];

export const DEFAULT_TRAJECTORY_METRIC =
  TRAJECTORY_METRICS[0] as TrajectoryMetric;

// ── Heatmap colors (dark surface) ─────────────────────────────────────────────
//
// A "dim filled" cell is a real value that's off/low; a *gap* (absent run, or no
// value for the metric) is never filled — it reads as empty (handled in CSS via
// `grid__cell--gap`). Green = good/present, blue = owned-cited, the accuracy ramp
// runs low(maroon)→high(green). These mirror the semantic palette used elsewhere
// (a future light theme would lift them to tokens, per the v1 dark-only scope).

/** Off/false cell — a real value, just the "no" state. */
const CELL_OFF = "#1a1d22";
const ON_MENTION = "#3f9d5a";
const ON_CITED = "#3f7fbf";
const ERR_BG = "#3a1f22";

/** Accuracy 1–5 ramp: maroon → amber → green (higher is better). */
const ACCURACY_SCALE: Record<number, string> = {
  1: "#5a2733",
  2: "#7a472e",
  3: "#7a6a2e",
  4: "#356a45",
  5: "#3f9d5a",
};

export type CellKind = "absent" | "error" | "value";

export interface CellAppearance {
  kind: CellKind;
  /** Background fill; "" for an absent cell (CSS renders the empty/hatch state). */
  bg: string;
  /** Foreground glyph color. */
  fg: string;
  /** The glyph shown in the cell ("✓", a score, "×", or "" / "·"). */
  glyph: string;
  /** The metric's value for this cell (or null) — surfaced so callers (e.g. the
   * grid tooltip) don't recompute `metric.value(cell)`. */
  value: number | null;
}

/** Map one cell + the active metric to its heatmap appearance. Keeps the gap rule
 * (absent ≠ a zero): an absent cell is its own `kind`, never a filled "0". */
export function cellAppearance(
  cell: TrajectoryCell | null,
  metric: TrajectoryMetric,
): CellAppearance {
  if (!cell)
    return {
      kind: "absent",
      bg: "",
      fg: "var(--fg-muted)",
      glyph: "",
      value: null,
    };
  if (cell.hasError)
    return {
      kind: "error",
      bg: ERR_BG,
      fg: "#ff8585",
      glyph: "×",
      value: null,
    };

  const v = metric.value(cell);
  if (v === null) {
    // Present, but no value for this metric (e.g. accuracy when not mentioned).
    return {
      kind: "value",
      bg: CELL_OFF,
      fg: "var(--fg-muted)",
      glyph: "·",
      value: null,
    };
  }
  if (metric.key === "accuracy") {
    const step = Math.max(1, Math.min(5, Math.round(v)));
    return {
      kind: "value",
      bg: ACCURACY_SCALE[step] as string,
      fg: "#f2f3f5",
      glyph: String(v),
      value: v,
    };
  }
  const on = metric.key === "mentioned" ? ON_MENTION : ON_CITED;
  return v === 1
    ? { kind: "value", bg: on, fg: "#08090a", glyph: "✓", value: v }
    : {
        kind: "value",
        bg: CELL_OFF,
        fg: "var(--fg-muted)",
        glyph: "",
        value: v,
      };
}

/** Mention-rate intensity for the list heat strip (a pooled 0–1 rate per run).
 * null is a gap (empty); otherwise a 5-step green ramp from off → full. */
export function rateColor(rate: number | null): string {
  if (rate === null) return "";
  if (rate <= 0) return CELL_OFF;
  if (rate < 0.34) return "#214a30";
  if (rate < 0.67) return "#2c6b40";
  if (rate < 1) return "#358a4f";
  return ON_MENTION;
}

export const pct = (rate: number | null): string =>
  rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;

export const count = (n: number): string => n.toLocaleString("en-US");

/** Run dates are "YYYY-MM-DD"; axes/strip ticks show the month-day for density. */
export const shortDate = (d: string): string => d.slice(5);

/** A cell's brand rank for the tooltip (rank shown raw; "—" when not ranked). */
export const rankLabel = (rank: string | null): string =>
  rank === null || rank === "not_ranked" ? "—" : rank;
