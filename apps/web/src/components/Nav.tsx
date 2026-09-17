// The unified top bar (brand · primary nav · account). Every page renders the
// same five links in the same order, with the current section highlighted, so the
// nav stays consistent instead of each page hand-rolling a bar that lists only the
// *other* pages. Sub-pages pass the section they belong to (a result/drilldown is
// "scoreboard", a prompt trajectory is "prompts") so the highlight still reads.
import type { Segment } from "@aio/db";
import { Link, useLocation } from "@tanstack/react-router";
import { signOut } from "../lib/auth-client";
import { SYNTHETIC_MARKER, isSyntheticScope } from "../lib/synthetic-view";

export type NavSection =
  | "scoreboard"
  | "prompts"
  | "competitive"
  | "cited"
  | "runs"
  | null;

function navClass(active: boolean): string {
  return active ? "shell__navlink shell__navlink--active" : "shell__navlink";
}

// ── Which link reads as current, and when (issue #39) ────────────────────────
//
// The highlight used to come from the `active` prop — a constant of the route
// component that is rendered — while each `Link` independently applied its own
// `active` class and `aria-current="page"` from the location. The location
// commits on click; the next route's component only renders once its loader
// resolves, so until then the *old* page's prop still marks the old section
// while the link you clicked already marks the new one. Measured on the seeded
// corpus: 4 of 91 frames with two nav links reading as current.
//
// So the section is resolved from the location instead, read through
// `useLocation` — the same store `Link` matches against, so the two cannot
// disagree in any frame. Pathname rather than `Link`'s own matching because the
// nav highlights a *section*, and two sections include pages whose path is not
// the link's: `/prompt/$promptId` belongs to Prompts, `/run/…/provider/…` to
// Scoreboard. `Link`'s matching is pinned to `exact` (below) so it can only ever
// agree with this map or stay silent — never contradict it.

/** Pages whose whole path is the section. `/` is here and not in the prefix list
 * below precisely because every path starts with it. */
const SECTION_BY_EXACT_PATH: Readonly<Record<string, NavSection>> = {
  "/": "scoreboard",
  "/prompts": "prompts",
  "/competitive": "competitive",
  "/cited": "cited",
  "/runs": "runs",
};

/** Parameterised pages, matched on their prefix. */
const SECTION_BY_PREFIX: ReadonlyArray<[string, NavSection]> = [
  ["/prompt/", "prompts"],
  ["/run/", "scoreboard"],
  // A single result is a leaf, not a section: nothing in the bar is current
  // there, which is what `active={null}` has always meant on that page.
  ["/result/", null],
];

/**
 * The section a pathname belongs to. `undefined` — distinct from the `null` that
 * means "deliberately no section" — when the path is not one of the dashboard's
 * own pages; the caller's declared `active` covers that case, so a route added
 * later still highlights something.
 */
export function sectionForPath(pathname: string): NavSection | undefined {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path in SECTION_BY_EXACT_PATH) return SECTION_BY_EXACT_PATH[path];
  for (const [prefix, section] of SECTION_BY_PREFIX) {
    if (path.startsWith(prefix)) return section;
  }
  return undefined;
}

/** Pinning every nav link to an exact pathname match keeps `Link`'s own active
 * state a subset of `sectionForPath`'s: on `/prompt/$id` no link matches and the
 * map alone marks Prompts, and nowhere can the two mark different links.
 * `includeSearch: false` because the nav highlights a section, not a scope — the
 * Scoreboard link stays current with the theme breakdown open. */
const SECTION_MATCH = { exact: true, includeSearch: false } as const;

export function Nav({
  active,
  segment,
  email,
  syntheticRuns,
  run,
}: {
  /**
   * The section this page declares it belongs to. The location is authoritative
   * (see `sectionForPath`); this is the fallback for a path the map has not
   * learned, so a route added later still highlights something.
   */
  active: NavSection;
  /** The scope most links carry, so switching pages preserves the segment. */
  segment: Segment;
  /** Absent when the deployment has no access gate — see lib/route-guard. */
  email?: string | null;
  /**
   * Every run flagged synthetic in the database (`fetchSyntheticRuns`). Required,
   * not optional, so a page added later cannot quietly ship without the marker —
   * the omission is a type error rather than an unlabelled dashboard.
   */
  syntheticRuns: readonly string[];
  /**
   * The run (or runs) this page actually renders numbers from. Omit on pages
   * that pool the whole corpus; see `isSyntheticScope`.
   */
  run?: string | readonly (string | null | undefined)[] | null;
}) {
  const synthetic = isSyntheticScope(syntheticRuns, run);
  // Read from the location store, in the same render `Link` reads it.
  const pathname = useLocation({ select: (l) => l.pathname });
  const fromPath = sectionForPath(pathname);
  const current = fromPath === undefined ? active : fromPath;
  return (
    <>
      <header className="shell__bar">
        <span className="shell__brand">aio</span>
        <nav className="shell__nav">
          <Link
            to="/"
            search={{ segment, byTheme: false, byProvider: false }}
            className={navClass(current === "scoreboard")}
            aria-current={current === "scoreboard" ? "page" : undefined}
            activeOptions={SECTION_MATCH}
          >
            Scoreboard
          </Link>
          <Link
            to="/prompts"
            search={{ segment, theme: "all" }}
            className={navClass(current === "prompts")}
            aria-current={current === "prompts" ? "page" : undefined}
            activeOptions={SECTION_MATCH}
          >
            Prompts
          </Link>
          <Link
            to="/competitive"
            search={{ segment, theme: "all" }}
            className={navClass(current === "competitive")}
            aria-current={current === "competitive" ? "page" : undefined}
            activeOptions={SECTION_MATCH}
          >
            Competitive
          </Link>
          <Link
            to="/cited"
            search={{ segment, theme: "all" }}
            className={navClass(current === "cited")}
            aria-current={current === "cited" ? "page" : undefined}
            activeOptions={SECTION_MATCH}
          >
            Cited
          </Link>
          <Link
            to="/runs"
            className={navClass(current === "runs")}
            aria-current={current === "runs" ? "page" : undefined}
            activeOptions={SECTION_MATCH}
          >
            Runs
          </Link>
        </nav>
        {/* No email means this deployment has no access gate (ALLOWED_EMAIL_DOMAINS
          unset), so there is no session to sign out of — the whole account
          region collapses rather than offering a button that does nothing. */}
        {email ? (
          <div className="shell__account">
            <span className="shell__email">{email}</span>
            <button
              type="button"
              className="shell__signout"
              onClick={() => {
                void signOut().then(() => {
                  window.location.href = "/login";
                });
              }}
            >
              Sign out
            </button>
          </div>
        ) : null}
      </header>
      {/* Not dismissible, and not a toast: a marker you can close is absent from
          the screenshot taken after you closed it. It sits under the bar on every
          page, in the caution colour, stating plainly that the numbers are
          invented — the seed corpus ranks real competitors with made-up figures,
          so an unlabelled picture of it would be a fabricated claim about real
          products. */}
      {synthetic ? (
        <div className="shell__synthetic" role="note">
          {SYNTHETIC_MARKER}
        </div>
      ) : null}
    </>
  );
}
