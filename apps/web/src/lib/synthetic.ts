// Server-side read of which ingested runs are synthetic (issue #4). Every page
// loads it, because the marker it drives has to be on every page: a caveat that
// only shows on the scoreboard is absent from the screenshot someone actually
// shares.
//
// Re-resolves the session here (the data boundary — route guards are UX only),
// like every other server function in this directory.
import { syntheticRunDates } from "@aio/db";
import { createServerFn } from "@tanstack/react-start";
import { requireSession } from "./require-session";

export const fetchSyntheticRuns = createServerFn({ method: "GET" }).handler(
  async (): Promise<string[]> => {
    await requireSession();
    return syntheticRunDates();
  },
);
