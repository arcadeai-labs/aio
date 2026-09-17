// Client-safe constants + formatters for the Cited view. Like competitive-view.ts,
// this imports nothing at runtime from @aio/db — importing a runtime value from
// @aio/db drags the Postgres driver into the browser bundle (it throws on load
// without DATABASE_URL), breaking hydration of the whole route. So the
// presentational constants live here, client-side.

/** "All themes" sentinel — must match the server's CITED_THEME_ALL. */
export const CITED_THEME_ALL = "all";

/** Single calm accent for the owned-citation reach line (one rate over time, not
 * a set of categories needing distinct colors).
 *
 * Deliberately no longer the same value as competitive's SOV_BAR. That shared
 * `#4f8cc9` measured 5.62:1 against the near-black chart surface — the lowest of
 * any drawn series, and this one line was the most-reported "empty" chart in
 * issue #25: a single thick unoccluded trend that still read as a blank box. It
 * is the same calm blue, lifted to 8.74:1. SOV_BAR keeps the original value: the
 * leaderboard bars are filled shapes, not 2.75px strokes, and they are legible
 * at 100% today. */
export const REACH_LINE = "#74b0f0";

export const pct = (rate: number | null): string =>
  rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;

export const count = (n: number): string => n.toLocaleString("en-US");

/** Run dates are "YYYY-MM-DD"; axes/headers show the month-day for density. */
export const shortDate = (d: string): string => d.slice(5);

/** Strip scheme + trailing slash so the owned-URL list reads as paths, not noisy
 * `https://…/` strings. Purely cosmetic — the full URL stays the link target. */
export const displayUrl = (url: string): string =>
  url.replace(/^https?:\/\//, "").replace(/\/$/, "");
