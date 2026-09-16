// Client-safe formatters for the scoreboard's values and deltas. Extracted from
// routes/index.tsx (issue #28) so the headline pill, the three breakdown tables,
// and any future view render a delta identically instead of re-deriving it.
//
// Like segments.ts / competitive-view.ts this imports only *types* from @aio/db:
// importing a runtime value would drag the Postgres driver into the browser
// bundle (it throws on load without DATABASE_URL) and break hydration.
import type { Delta } from "@aio/db";

export const pct = (rate: number | null): string =>
  rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;

/** Accuracy is a 1–5 score, not a rate. */
export const score = (mean: number | null): string =>
  mean === null ? "—" : mean.toFixed(2);

export const count = (n: number): string => n.toLocaleString("en-US");

// Every delta keeps an explicit +/−/± sign: direction must be legible without
// reading color (spec §9), so the sign — not the hue — is the primary signal.
const signed = (value: number, digits: number): string => {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `${sign}${Math.abs(value).toFixed(digits)}`;
};

/** A rate delta in percentage *points*, 1 dp — e.g. "+1.8" / "−0.4" / "±0.0".
 * The unit belongs in the column header/tooltip, not in every cell. */
export function deltaPts(d: Delta): string {
  if (d.absolute === null) return "—";
  return signed(d.absolute * 100, 1);
}

/** The headline pill's variant, which can afford the unit inline. */
export function deltaPtsLabeled(d: Delta): string {
  if (d.absolute === null) return "—";
  return `${signed(d.absolute * 100, 1)} pts`;
}

/** An accuracy delta in raw score units, 2 dp — e.g. "+0.20" / "−0.05". Accuracy
 * is a 1–5 score, so percentage points would be a category error. */
export function deltaScore(d: Delta): string {
  if (d.absolute === null) return "—";
  return signed(d.absolute, 2);
}

/** A count delta — whole units, no decimals ("+12" / "−3" / "±0"). Rendered
 * neutral: a bigger or smaller denominator is neither good nor bad. */
export function deltaCount(d: Delta): string {
  if (d.absolute === null) return "—";
  return signed(d.absolute, 0);
}

/** The headline's delta pill; the compact table-cell variant. Both carry the same
 * `--up`/`--down`/`--flat` semantics and tabular numerals, so a delta reads the
 * same everywhere — the table variant is just quieter. */
export const HEADLINE_DELTA = "score__delta";
export const TABLE_DELTA = "themes__delta";

/**
 * Green = gain, red = loss (spec §9: green/red reserved for gain/loss signal).
 * `direction` is the *goodness* direction, already polarity-corrected upstream —
 * the coverage table's error rate arrives inverted (rising errors read as a loss),
 * so this never needs to know which metric it's coloring.
 */
export function deltaClass(d: Delta, base: string = HEADLINE_DELTA): string {
  const dir =
    d.direction === "up" ? "up" : d.direction === "down" ? "down" : "flat";
  return `${base} ${base}--${dir}`;
}

/** A count delta's class — explicitly neutral, never green/red. */
export function neutralDeltaClass(base: string = TABLE_DELTA): string {
  return `${base} ${base}--neutral`;
}

/** The marker for a key that's new in the active run (a fact, not a missing
 * value — so never "—"). */
export function newDeltaClass(base: string = TABLE_DELTA): string {
  return `${base} ${base}--new`;
}
