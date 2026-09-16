// Server-side query for the provider drill-down list (issue #9): one run ×
// provider's prompt-results, scoped to a segment. Re-resolves the session here
// (the data boundary — route guards are UX only) so this private data never
// leaves the server to an anonymous caller. Mirrors src/lib/scoreboard.ts.
import { type ProviderDrilldown, providerDrilldown } from "@aio/db";
import { createServerFn } from "@tanstack/react-start";
import { requireSession } from "./require-session";
import { toSegment } from "./segments";

export const fetchProviderDrilldown = createServerFn({ method: "GET" })
  .validator((input: { provider: string; segment?: string; run?: string }) => ({
    provider: input.provider,
    segment: toSegment(input.segment),
    // The run date is validated downstream against the real ingested-run list
    // (an unknown date falls back to the latest), so here we only coerce the type.
    run: typeof input.run === "string" ? input.run : undefined,
  }))
  .handler(async ({ data }): Promise<ProviderDrilldown> => {
    await requireSession();
    return providerDrilldown(data.provider, data.segment, data.run);
  });
