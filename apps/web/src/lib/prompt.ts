// Server-side queries for the prompt-trajectory pages (issue #13): the prompt
// list (with mention sparklines) and one prompt's per-provider trajectory.
// Re-resolves the session here (the data boundary — route guards are UX only) so
// this private data never leaves the server to an anonymous caller. Mirrors
// src/lib/cited.ts.
import {
  type PromptListView,
  type PromptTrajectory,
  promptList,
  promptTrajectory,
} from "@aio/db";
import { createServerFn } from "@tanstack/react-start";
import { requireSession } from "./require-session";
import { toSegment } from "./segments";

export const fetchPromptList = createServerFn({ method: "GET" })
  .validator((input: { segment?: string; run?: string; theme?: string }) => ({
    segment: toSegment(input.segment),
    // Run date and theme are validated downstream against the real ingested data
    // (an unknown run falls back to the latest; an absent/"all" theme is a no-op).
    run: typeof input.run === "string" ? input.run : undefined,
    theme: typeof input.theme === "string" ? input.theme : undefined,
  }))
  .handler(async ({ data }): Promise<PromptListView> => {
    await requireSession();
    return promptList(data.segment, data.run, data.theme);
  });

export const fetchPromptTrajectory = createServerFn({ method: "GET" })
  .validator((input: { promptId: string }) => ({
    promptId: String(input.promptId),
  }))
  .handler(async ({ data }): Promise<PromptTrajectory> => {
    await requireSession();
    return promptTrajectory(data.promptId);
  });
