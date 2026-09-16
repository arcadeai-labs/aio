// Server-side query for the Cited view (issue #12): the owned-citation cohort
// (`owned_cited = true`) for a segment/theme scope — owned-citation reach over
// run dates plus which owned URLs appear and the results that cited them.
// Re-resolves the session here (the data boundary — route guards are UX only) so
// this private data never leaves the server to an anonymous caller. Mirrors
// src/lib/competitive.ts.
import { type CitedView, citedView } from "@aio/db";
import { createServerFn } from "@tanstack/react-start";
import { requireSession } from "./require-session";
import { toSegment } from "./segments";

export const fetchCitedView = createServerFn({ method: "GET" })
  .validator((input: { segment?: string; run?: string; theme?: string }) => ({
    segment: toSegment(input.segment),
    // Run date and theme are validated downstream against the real ingested data
    // (an unknown run falls back to the latest; an absent/"all" theme is a no-op),
    // so here we only coerce the types.
    run: typeof input.run === "string" ? input.run : undefined,
    theme: typeof input.theme === "string" ? input.theme : undefined,
  }))
  .handler(async ({ data }): Promise<CitedView> => {
    await requireSession();
    return citedView(data.segment, data.run, data.theme);
  });
