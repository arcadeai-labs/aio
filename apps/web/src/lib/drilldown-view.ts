// Pure filter + sort for the provider drill-down list (issue #9). Kept free of
// React and of @aio/db's runtime (only the row *type* is imported, type-only, so
// the Postgres driver never reaches the browser bundle — same trick as
// segments.ts). The list is ≤533 rows, so all sorting/filtering runs client-side
// over the already-fetched set; this module is that logic, unit-tested over
// fixtures so the table renders exactly what the tests assert.
import type { DrilldownRow } from "@aio/db";

export type SortKey =
  | "prompt"
  | "theme"
  | "mentioned"
  | "accuracy"
  | "rank"
  | "cited";
export type SortDir = "asc" | "desc";

/** Tri-state boolean filters: all rows, only true, or only false. */
export type TriFilter = "all" | "yes" | "no";
/** Rank filter: any rank, or one specific brand_rank value. */
export type RankFilter = "all" | "1" | "2" | "3" | "not_ranked";

// Sentinel for the "no theme" bucket in the theme filter — a real value so it
// round-trips through a <select> (which can't carry null). "all" means no theme
// filter; "__none" means rows whose runTheme is null.
export const THEME_ALL = "all";
export const THEME_NONE = "__none";

export interface DrilldownView {
  sortKey: SortKey;
  sortDir: SortDir;
  mentioned: TriFilter;
  cited: TriFilter;
  rank: RankFilter;
  /** THEME_ALL, THEME_NONE, or a concrete theme string. */
  theme: string;
}

export const DEFAULT_VIEW: DrilldownView = {
  sortKey: "prompt",
  sortDir: "asc",
  mentioned: "all",
  cited: "all",
  rank: "all",
  theme: THEME_ALL,
};

// A tri-state filter on a nullable boolean. "yes"/"no" exclude null (errored /
// no-verdict rows), so those show only under "all" — the failures stay findable
// without polluting a "not mentioned" filter with rows that were never judged.
function passTri(value: boolean | null, filter: TriFilter): boolean {
  if (filter === "all") return true;
  if (filter === "yes") return value === true;
  return value === false;
}

export function filterRows(
  rows: readonly DrilldownRow[],
  view: DrilldownView,
): DrilldownRow[] {
  return rows.filter((r) => {
    if (!passTri(r.mentioned, view.mentioned)) return false;
    if (!passTri(r.ownedCited, view.cited)) return false;
    if (view.rank !== "all" && r.brandRank !== view.rank) return false;
    if (view.theme === THEME_NONE && r.runTheme !== null) return false;
    if (
      view.theme !== THEME_ALL &&
      view.theme !== THEME_NONE &&
      r.runTheme !== view.theme
    )
      return false;
    return true;
  });
}

// Rank sorts best→worst with not_ranked, then null (no verdict), pushed to the
// end regardless of direction.
const RANK_ORDER: Record<string, number> = {
  "1": 0,
  "2": 1,
  "3": 2,
  not_ranked: 3,
};
const rankIndex = (rank: string | null): number =>
  rank === null ? 99 : (RANK_ORDER[rank] ?? 98);

// Comparator over the *non-null* values of a key, returning ascending order; the
// direction flip is applied to this result only. Null operands never reach here —
// they're partitioned to the end first (see sortRows), so an errored / no-verdict
// row always sits last regardless of sort direction rather than jumping to the
// top when the column is sorted descending.
function compareAsc(a: DrilldownRow, b: DrilldownRow, key: SortKey): number {
  switch (key) {
    case "prompt":
      return a.promptText.localeCompare(b.promptText);
    case "theme":
      return (a.runTheme as string).localeCompare(b.runTheme as string);
    case "mentioned":
      return boolRank(a.mentioned) - boolRank(b.mentioned);
    case "cited":
      return boolRank(a.ownedCited) - boolRank(b.ownedCited);
    case "rank":
      return rankIndex(a.brandRank) - rankIndex(b.brandRank);
    case "accuracy":
      return (a.accuracyScore as number) - (b.accuracyScore as number);
  }
}

// false < true ascending.
const boolRank = (v: boolean | null): number => (v ? 1 : 0);

// Whether a row's value for the active key is "null" — the missing-data states
// that always sort last. brandRank is NOT NULL in the schema but is null here on
// a LEFT JOIN miss (no verdict), which we treat like the other nulls.
function keyIsNull(row: DrilldownRow, key: SortKey): boolean {
  switch (key) {
    case "prompt":
      return false;
    case "theme":
      return row.runTheme === null;
    case "mentioned":
      return row.mentioned === null;
    case "cited":
      return row.ownedCited === null;
    case "rank":
      return row.brandRank === null;
    case "accuracy":
      return row.accuracyScore === null;
  }
}

export function sortRows(
  rows: readonly DrilldownRow[],
  view: DrilldownView,
): DrilldownRow[] {
  const dir = view.sortDir === "asc" ? 1 : -1;
  const key = view.sortKey;
  // Copy before sorting — never mutate the loader's array in place.
  return [...rows].sort((a, b) => {
    // Nulls partition to the end before direction is applied, so flipping the
    // sort never lifts a missing-data row above real values.
    const aNull = keyIsNull(a, key);
    const bNull = keyIsNull(b, key);
    if (aNull !== bNull) return aNull ? 1 : -1;
    if (!aNull) {
      const cmp = compareAsc(a, b, key);
      if (cmp !== 0) return cmp * dir;
    }
    // Stable tie-break: prompt first so equal (or both-null) rows read
    // alphabetically, then resultId as a total order so ties stay fully
    // deterministic even if two rows share identical prompt text.
    const byPrompt = a.promptText.localeCompare(b.promptText);
    return byPrompt !== 0 ? byPrompt : a.resultId.localeCompare(b.resultId);
  });
}

/** Filter then sort — the full client-side view transform for the list. */
export function applyDrilldownView(
  rows: readonly DrilldownRow[],
  view: DrilldownView,
): DrilldownRow[] {
  return sortRows(filterRows(rows, view), view);
}

/** Distinct themes present in the rows, for the theme filter dropdown. Concrete
 * themes alphabetical; a `null` (no-theme) bucket is reported via `hasNone`. */
export function themeOptions(rows: readonly DrilldownRow[]): {
  themes: string[];
  hasNone: boolean;
} {
  const set = new Set<string>();
  let hasNone = false;
  for (const r of rows) {
    if (r.runTheme === null) hasNone = true;
    else set.add(r.runTheme);
  }
  return { themes: [...set].sort((a, b) => a.localeCompare(b)), hasNone };
}
