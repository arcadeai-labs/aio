// The segment axis, client-safe. `Segment` is a type-only import from @aio/db so
// nothing here drags the Postgres driver into the browser bundle — the route
// (client) and fetchScoreboard (server fn) both read these without pulling in
// @aio/db's runtime. Single source for the segment list, its URL coercion, and
// its display labels.
import type { Segment } from "@aio/db";

/** Every segment, in display order. */
export const SEGMENTS: readonly Segment[] = ["global", "branded", "unbranded"];

/**
 * Coerce arbitrary input to a valid segment; anything unrecognized (or absent)
 * falls back to `global`, so a hand-typed URL can never wedge the scoreboard.
 * Shared by the route's `validateSearch` and the server fn's validator so both
 * boundaries coerce identically.
 */
export function toSegment(value: unknown): Segment {
  return SEGMENTS.includes(value as Segment) ? (value as Segment) : "global";
}

export const SEGMENT_LABEL: Record<Segment, string> = {
  global: "Global",
  branded: "Branded",
  unbranded: "Unbranded",
};
