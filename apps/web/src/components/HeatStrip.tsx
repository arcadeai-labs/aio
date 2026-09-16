// A one-row heatmap strip previewing a prompt's mention-rate trend in list rows
// (issue #13). Matches the trajectory grid's language rather than a line chart:
// one cell per run (oldest → newest), shaded by the pooled mention rate, with an
// empty cell for a gap (a run where the prompt was absent — never a filled zero).
// The active run is outlined so the strip ties to the list's run scope.
import { rateColor, shortDate } from "../lib/trajectory-view";

export function HeatStrip({
  values,
  runDates,
  activeIndex,
  ariaLabel,
}: {
  /** Mention rate per run, in `runDates` order; null = absent (a gap). */
  values: (number | null)[];
  runDates: string[];
  /** Index of the active run to outline, or -1. */
  activeIndex: number;
  ariaLabel?: string;
}) {
  return (
    <div
      className="strip"
      role="img"
      aria-label={ariaLabel ?? "Mention-rate trend"}
    >
      {values.map((v, i) => {
        const bg = rateColor(v);
        const date = runDates[i] ?? "";
        const label =
          v === null ? "absent" : `${Math.round(v * 100)}% of providers`;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed run-aligned strip
            key={i}
            className={
              v === null
                ? `strip__cell strip__cell--gap${i === activeIndex ? " strip__cell--active" : ""}`
                : `strip__cell${i === activeIndex ? " strip__cell--active" : ""}`
            }
            style={bg ? { background: bg } : undefined}
            title={`${shortDate(date)} — ${label}`}
          />
        );
      })}
    </div>
  );
}
