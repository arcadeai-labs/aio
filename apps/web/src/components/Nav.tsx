// The unified top bar (brand · primary nav · account). Every page renders the
// same five links in the same order, with the current section highlighted, so the
// nav stays consistent instead of each page hand-rolling a bar that lists only the
// *other* pages. Sub-pages pass the section they belong to (a result/drilldown is
// "scoreboard", a prompt trajectory is "prompts") so the highlight still reads.
import type { Segment } from "@aio/db";
import { Link } from "@tanstack/react-router";
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

export function Nav({
  active,
  segment,
  email,
  syntheticRuns,
  run,
}: {
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
  return (
    <>
      <header className="shell__bar">
        <span className="shell__brand">aio</span>
        <nav className="shell__nav">
          <Link
            to="/"
            search={{ segment, byTheme: false, byProvider: false }}
            className={navClass(active === "scoreboard")}
            aria-current={active === "scoreboard" ? "page" : undefined}
          >
            Scoreboard
          </Link>
          <Link
            to="/prompts"
            search={{ segment, theme: "all" }}
            className={navClass(active === "prompts")}
            aria-current={active === "prompts" ? "page" : undefined}
          >
            Prompts
          </Link>
          <Link
            to="/competitive"
            search={{ segment, theme: "all" }}
            className={navClass(active === "competitive")}
            aria-current={active === "competitive" ? "page" : undefined}
          >
            Competitive
          </Link>
          <Link
            to="/cited"
            search={{ segment, theme: "all" }}
            className={navClass(active === "cited")}
            aria-current={active === "cited" ? "page" : undefined}
          >
            Cited
          </Link>
          <Link
            to="/runs"
            className={navClass(active === "runs")}
            aria-current={active === "runs" ? "page" : undefined}
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
