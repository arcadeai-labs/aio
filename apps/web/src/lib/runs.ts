// Server-side query for the gated "Runs" readout: each ingested run with its
// date, row counts, and freshness. Re-resolves the session here (the data
// boundary — route guards are UX only) so this private data never leaves the
// server to an anonymous caller.
import { db, ingestRuns } from "@aio/db";
import { createServerFn } from "@tanstack/react-start";
import { desc } from "drizzle-orm";
import { requireSession } from "./require-session";

export interface RunSummary {
  runDate: string;
  resultCount: number;
  verdictCount: number;
  orphanVerdictCount: number;
  status: string;
  ingestedAt: string;
}

export const fetchRuns = createServerFn({ method: "GET" }).handler(
  async (): Promise<RunSummary[]> => {
    await requireSession();

    const rows = await db
      .select()
      .from(ingestRuns)
      .orderBy(desc(ingestRuns.runDate));

    return rows.map((r) => ({
      runDate: r.runDate,
      resultCount: r.resultCount,
      verdictCount: r.verdictCount,
      orphanVerdictCount: r.orphanVerdictCount,
      status: r.status,
      ingestedAt:
        r.ingestedAt instanceof Date
          ? r.ingestedAt.toISOString()
          : String(r.ingestedAt),
    }));
  },
);
