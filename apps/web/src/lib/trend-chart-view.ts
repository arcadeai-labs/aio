// Pure row-selection for the trend chart's crosshair tooltip. Extracted from
// TrendChart.tsx so the cap-and-sort rule — the thing that decides whether a
// drawn line's *value* is actually readable — is unit-testable without rendering
// a chart.

/** The tooltip's view of one series at the hovered run. */
export interface TooltipCandidate {
  label: string;
  color: string;
  /** The series' value at the hovered index; null/undefined = a gap, dropped. */
  v: number | null | undefined;
  /** Pinned series lead the list, so the row cap can never drop them. */
  pinned?: boolean;
}

export interface TooltipRow {
  label: string;
  color: string;
  v: number;
}

/**
 * Pick the tooltip's rows: drop gaps, put pinned series first, then sort the rest
 * by value descending, then cap.
 *
 * The cap exists so a 30-competitor chart stays readable, but a naive
 * value-sorted cap silently hides whichever series happens to rank low — which
 * for the brand's own line is the whole question the chart is there to answer
 * ("where do we sit"). Pinning is applied *before* the cap, so trimming can only
 * ever remove context, never the reader's anchor.
 */
export function tooltipRows(
  candidates: readonly TooltipCandidate[],
  limit: number,
): TooltipRow[] {
  return candidates
    .filter((r): r is TooltipCandidate & { v: number } => r.v != null)
    .sort((a, b) => {
      const ap = a.pinned === true;
      const bp = b.pinned === true;
      if (ap !== bp) return ap ? -1 : 1;
      return b.v - a.v;
    })
    .slice(0, limit)
    .map(({ label, color, v }) => ({ label, color, v }));
}
