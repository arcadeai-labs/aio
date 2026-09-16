// Client-safe constants + formatters for the Cited view. Like competitive-view.ts,
// this imports nothing at runtime from @aio/db — importing a runtime value from
// @aio/db drags the Postgres driver into the browser bundle (it throws on load
// without DATABASE_URL), breaking hydration of the whole route. So the
// presentational constants live here, client-side.

/** "All themes" sentinel — must match the server's CITED_THEME_ALL. */
export const CITED_THEME_ALL = "all";

/** Single calm accent for the owned-citation reach line (one rate over time, not
 * a set of categories needing distinct colors). Matches competitive's SOV_BAR. */
export const REACH_LINE = "#4f8cc9";

export const pct = (rate: number | null): string =>
  rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;

export const count = (n: number): string => n.toLocaleString("en-US");

/** Run dates are "YYYY-MM-DD"; axes/headers show the month-day for density. */
export const shortDate = (d: string): string => d.slice(5);

/** Strip scheme + trailing slash so the owned-URL list reads as paths, not noisy
 * `https://…/` strings. Purely cosmetic — the full URL stays the link target. */
export const displayUrl = (url: string): string =>
  url.replace(/^https?:\/\//, "").replace(/\/$/, "");
