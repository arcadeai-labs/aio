// Server-side query for the Competitive Landscape view (issue #11): the
// competitive cohort (`others_present = true`) for a segment/theme scope, with
// rank distribution + per-competitor share-of-voice and their trend over run
// dates. Re-resolves the session here (the data boundary — route guards are UX
// only) so this private data never leaves the server to an anonymous caller.
// Mirrors src/lib/drilldown.ts.
import { type CompetitiveLandscape, competitiveLandscape } from "@aio/db";
import { createServerFn } from "@tanstack/react-start";
import { requireSession } from "./require-session";
import { toSegment } from "./segments";

export const fetchCompetitiveLandscape = createServerFn({ method: "GET" })
  .validator((input: { segment?: string; run?: string; theme?: string }) => ({
    segment: toSegment(input.segment),
    // Run date and theme are validated downstream against the real ingested data
    // (an unknown run falls back to the latest; an absent/"all" theme is a no-op),
    // so here we only coerce the types.
    run: typeof input.run === "string" ? input.run : undefined,
    theme: typeof input.theme === "string" ? input.theme : undefined,
  }))
  .handler(async ({ data }): Promise<CompetitiveLandscape> => {
    await requireSession();
    return competitiveLandscape(data.segment, data.run, data.theme);
  });
