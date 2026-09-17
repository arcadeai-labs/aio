// The segment control (Global · Branded · Unbranded), shared by the scoreboard
// and the Cited view (issue #39).
//
// ── One clock, and it is the URL ─────────────────────────────────────────────
//
// Both call sites used to mark the current pill from the route's *data* —
// `scoreboard.segment` on the scoreboard, `Route.useSearch()` on Cited — while
// the `Link` underneath independently applied its own `active` class and
// `aria-current="page"` from the *location*. The location commits as soon as the
// click is handled; the route's data arrives a render or more later. For that
// window two mutually exclusive pills both read as current: measured on the
// seeded corpus at 3 of 91 frames on the scoreboard and 2 of 91 on Cited.
//
// So the control is driven from one source, `Link`'s own active state, which
// reads the same location store the router routes on. There is no second
// derivation left to disagree with it: no `--active` class computed here, and no
// hand-written `aria-current` — `Link` supplies `aria-current="page"` itself,
// which is the attribute assistive tech actually reads.
//
// The consequence is deliberate: the control now *leads* the numbers by the
// width of the loader. That window is safe only because issue #23 made every
// headline figure cut rather than tween across a cohort change, so the tiles
// below never print one segment's rate over another segment's denominator while
// the pill is ahead of them. Do not reintroduce that from this end.
import { Link } from "@tanstack/react-router";
import { SEGMENTS, SEGMENT_LABEL } from "../lib/segments";

/** The two skins the control ships in — the scoreboard's inline segmented
 * control, and the panel pills the drill-down views use. Same behaviour, same
 * markup; only the class names differ. */
export const SEGMENT_PILL_VARIANTS = {
  scoreboard: {
    list: "segctl",
    pill: "segctl__opt",
    active: "segctl__opt--active",
  },
  panel: {
    list: "comp__segctl",
    pill: "comp__seg",
    active: "comp__seg--active",
  },
} as const;

export type SegmentPillVariant = keyof typeof SEGMENT_PILL_VARIANTS;

export function SegmentPills({
  to,
  variant,
}: {
  /** The route these pills re-scope — they never leave the page they are on. */
  to: "/" | "/cited";
  variant: SegmentPillVariant;
}) {
  const style = SEGMENT_PILL_VARIANTS[variant];
  return (
    <div className={style.list}>
      {SEGMENTS.map((s) => (
        <Link
          key={s}
          to={to}
          // biome-ignore lint/suspicious/noExplicitAny: search-updater preserves all params
          search={(prev: any) => ({ ...prev, segment: s })}
          className={style.pill}
          // The whole fix: the active class comes from the link's own match
          // against the location, so it cannot disagree with `aria-current`.
          activeProps={{ className: style.active }}
        >
          {SEGMENT_LABEL[s]}
        </Link>
      ))}
    </div>
  );
}
