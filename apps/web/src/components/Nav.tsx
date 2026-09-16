// The unified top bar (brand · primary nav · account). Every page renders the
// same five links in the same order, with the current section highlighted, so the
// nav stays consistent instead of each page hand-rolling a bar that lists only the
// *other* pages. Sub-pages pass the section they belong to (a result/drilldown is
// "scoreboard", a prompt trajectory is "prompts") so the highlight still reads.
import type { Segment } from "@aio/db";
import { Link } from "@tanstack/react-router";
import { signOut } from "../lib/auth-client";

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
}: {
  active: NavSection;
  /** The scope most links carry, so switching pages preserves the segment. */
  segment: Segment;
  /** Absent when the deployment has no access gate — see lib/route-guard. */
  email?: string | null;
}) {
  return (
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
  );
}
