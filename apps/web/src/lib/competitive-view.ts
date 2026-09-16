// Client-safe constants + formatters for the Competitive Landscape view. Like
// segments.ts, this imports only *types* from @aio/db — importing a runtime value
// from @aio/db would drag the Postgres driver into the browser bundle (it throws
// on load without DATABASE_URL), which breaks hydration of the whole route. So
// the presentational constants live here, client-side.
import type { BrandRankKey } from "@aio/db";

/** "All themes" sentinel — must match the server's COMPETITIVE_THEME_ALL. */
export const COMPETITIVE_THEME_ALL = "all";

/** The four brand-rank buckets, best→worst display order. */
export const BRAND_RANK_KEYS: readonly BrandRankKey[] = [
  "1",
  "2",
  "3",
  "not_ranked",
];

export const RANK_LABEL: Record<BrandRankKey, string> = {
  "1": "1st",
  "2": "2nd",
  "3": "3rd",
  not_ranked: "Not ranked",
};

// Rank is good→bad signal: green (1st) → teal → amber → muted red (not ranked).
// The same hues are used by the rank bars and the rank trend lines.
export const RANK_COLOR: Record<BrandRankKey, string> = {
  "1": "#4ade80",
  "2": "#5eead4",
  "3": "#fbbf24",
  not_ranked: "#ff8585",
};

// Categorical palette for the highlighted share-of-voice lines (top competitors).
// Chart-only: nothing else renders from this list, so its values answer to
// traceability rather than to the bar styling.
//
// Three rules, all asserted in trend-chart-theme.test.ts, because this is a list
// a future contributor will extend:
//
//  1. Every slot clears 7:1 against the near-black surface. A line nobody can
//     see is the whole of issue #25.
//  2. Every slot is at least 20 ΔE from every other. Two series that read as one
//     line where they cross is the same "plausible but wrong" failure as a line
//     nobody can see.
//  3. No slot is green or red. DESIGN.md §9 reserves both strictly for deltas and
//     good/bad signal, and these are ordinary competitor lines — not signal. A
//     competitor drawn in green reads as "good" to anyone scanning, and on share
//     of voice a competitor climbing is precisely the *bad* news, so the colour
//     would invert the meaning of the chart. {@link RANK_COLOR} is the sanctioned
//     use: there the ramp *is* the good→bad signal.
//
// Slot 0 was #4ade80 — the literal rank-1 green — and slot 9 was #f87171. Both
// broke rule 3. They are now copper and cyan, chosen to hold rules 1 and 2 flat:
// the worst pair among the seven drawn on /competitive is unchanged at 31.3 ΔE
// (#60a5fa vs #a78bfa, neither of them touched here), and the palette's lowest
// contrast rises from 7.20:1 to 7.32:1.
//
// Slot 8 was #facc15, which measured 9.6 ΔE from slot 2's #fbbf24 — with nine or
// more competitors highlighted the two were effectively the same yellow. The
// shipped corpus draws six, so nothing on screen today collided; it was waiting
// for a wider brand set.
export const SOV_PALETTE = [
  "#cfa76f",
  "#60a5fa",
  "#fbbf24",
  "#f472b6",
  "#2dd4bf",
  "#a78bfa",
  "#fb923c",
  "#38bdf8",
  "#e879f9",
  "#67e8f9",
];

/** Single calm accent for the focused-run leaderboard bars (a ranking, not a set
 * of categories needing distinct colors). */
export const SOV_BAR = "#4f8cc9";

/**
 * The brand's own accent in every share-of-voice rendering (issue #40) — the
 * near-white interactive accent (`--accent`), deliberately *not* a SOV_PALETTE
 * slot or SOV_BAR, so it can never collide with a competitor's color. Color is
 * never the only signal: every brand rendering also carries the explicit
 * {@link BRAND_MARKER}.
 */
export const BRAND_SOV = "#ededf0";

/** The explicit "this row is us" marker that accompanies {@link BRAND_SOV}. */
export const BRAND_MARKER = "us";

/** How many of the SoV trend series are highlighted (the rest are dimmed). */
export const SOV_HIGHLIGHT_COUNT = 10;

export const pct = (rate: number | null): string =>
  rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;

export const count = (n: number): string => n.toLocaleString("en-US");

/** Run dates are "YYYY-MM-DD"; axes/headers show the month-day for density. */
export const shortDate = (d: string): string => d.slice(5);
