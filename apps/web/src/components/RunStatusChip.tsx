// The run-health chip, rendered once for both pages that show it (issue #28):
// the scoreboard's freshness strip and the /runs table. It takes the raw
// provenance counts rather than a pre-computed label, so neither caller can hand
// it a status it did not derive — that split is exactly how the 2026-08-03
// outage week came to read `partial` on the scoreboard and `ok` on /runs.
//
// The two pages keep their own BEM blocks (the chips sit in different
// surroundings and are sized differently in styles.css); `variant` selects one.
import { type RunCounts, runHealth } from "../lib/run-health";

const BLOCK = {
  fresh: "fresh__status",
  runs: "runs__status",
} as const;

export type RunStatusVariant = keyof typeof BLOCK;

export function RunStatusChip({
  run,
  variant,
}: {
  run: RunCounts;
  variant: RunStatusVariant;
}) {
  const { degraded, label } = runHealth(run);
  const base = BLOCK[variant];
  return (
    <span
      className={degraded ? `${base} ${base}--warn` : `${base} ${base}--ok`}
    >
      {label}
    </span>
  );
}
