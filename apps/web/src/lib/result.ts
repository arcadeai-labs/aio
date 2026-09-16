// Server-side query for a single result's detail (issue #9 wires the link target;
// the editorial view itself is issue #10). Re-resolves the session here (the data
// boundary — route guards are UX only) so this private data never leaves the
// server to an anonymous caller. Mirrors src/lib/scoreboard.ts.
import { type ResultDetail, resultDetail } from "@aio/db";
import { createServerFn } from "@tanstack/react-start";
import { requireSession } from "./require-session";

export const fetchResultDetail = createServerFn({ method: "GET" })
  .validator((input: { id: string }) => ({ id: input.id }))
  .handler(async ({ data }): Promise<ResultDetail | null> => {
    await requireSession();
    return resultDetail(data.id);
  });
