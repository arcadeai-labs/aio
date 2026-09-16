// Server-side query for the gated home scoreboard: the latest run's full
// headline (all four metrics + cohort funnel), per-provider coverage, and WoW
// deltas. Re-resolves the session here (the data boundary — route guards are UX
// only) so this private data never leaves the server to an anonymous caller.
// Mirrors src/lib/runs.ts.
import { type Scoreboard, scoreboard } from "@aio/db";
import { createServerFn } from "@tanstack/react-start";
import { requireSession } from "./require-session";
import { toSegment } from "./segments";

export const fetchScoreboard = createServerFn({ method: "GET" })
  .validator((input: { segment?: string; run?: string } | undefined) => ({
    segment: toSegment(input?.segment),
    // The run date is validated downstream against the real ingested-run list
    // (an unknown date falls back to the latest), so here we only coerce the type.
    run: typeof input?.run === "string" ? input.run : undefined,
  }))
  .handler(async ({ data }): Promise<Scoreboard> => {
    await requireSession();
    return scoreboard(data.segment, data.run);
  });
