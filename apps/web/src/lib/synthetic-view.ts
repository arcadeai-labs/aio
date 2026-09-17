// Whether what a page is showing is synthetic — derived in one place, the way
// run-health.ts derives a run's status in one place (issue #28). Two pages that
// disagree about whether the same data is invented would be worse than either
// answer alone.
//
// Browser-safe: types and pure functions only. The DB read lives in lib/
// synthetic.ts (a server function); importing a runtime value from @aio/db here
// would drag the Postgres driver into the client bundle.

/**
 * The marker's wording. One fixed, non-dismissible sentence, kept here so the
 * header and any future surface can't drift into two different claims.
 *
 * It has to survive being screenshotted with no surrounding context: someone who
 * sees only the image must be able to tell the numbers were generated. That is
 * why it says *invented* rather than "demo" or "sample" — the shipped seed corpus
 * attaches made-up numbers to real competitor names (Todoist, TickTick, Notion,
 * Asana, Things 3), so a vague word here would leave a picture of invented
 * rankings of real products looking exactly like a measurement.
 */
export const SYNTHETIC_MARKER =
  "Synthetic data — these numbers are invented for exploring the dashboard, not measured.";

/**
 * Does the header marker belong on this page?
 *
 * `syntheticRuns` is the full set of runs flagged synthetic in the database (see
 * `syntheticRunDates`); `runs` is the run — or runs — whose numbers this page
 * actually puts on screen.
 *
 * - **A page that renders specific runs** (the scoreboard renders the active run
 *   *and* the prior one it deltas against; a drill-down or result detail renders
 *   one) names them, and is marked exactly when one of them is flagged. This is
 *   what makes the marker readable: with real runs on screen it is absent, so its
 *   presence means something.
 * - **A page that pools every run** (prompts, a prompt trajectory, the competitive
 *   and cited trends, /runs) passes nothing, and is marked when *any* ingested run
 *   is synthetic. Those pages draw a line through the whole corpus, so scoping
 *   their marker to a "selected" run would leave a fabricated trend line — the
 *   seeded competitor overtake, say — rendered unlabelled next to a real one.
 *
 * Absence is never inferred into presence: an empty `syntheticRuns` (the normal
 * state for a corpus ingested before this feature existed) marks nothing, and a
 * named run that isn't flagged marks nothing.
 */
export function isSyntheticScope(
  syntheticRuns: readonly string[],
  runs?: string | readonly (string | null | undefined)[] | null,
): boolean {
  if (syntheticRuns.length === 0) return false;
  if (runs == null) return true;
  const scoped = typeof runs === "string" ? [runs] : runs;
  return scoped.some((r) => r != null && syntheticRuns.includes(r));
}
