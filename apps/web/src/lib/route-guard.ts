// Shared route guard for every authenticated page.
//
// This is UX, not authorization. The authoritative gate is upstream — when
// `ALLOWED_EMAIL_DOMAINS` is set, better-auth only ever issues a session to an
// account on an allowed domain (see lib/auth.ts) — and every server function
// that returns data re-resolves the session itself. A guard that is bypassed
// gets you a blank page, not someone else's data.
//
// It lives in one place because the previous shape (an identical eight-line
// `beforeLoad` copy-pasted into each of eight routes) meant any change to the
// access model had to be made eight times, and missing one would fail open in
// exactly the way that is hardest to notice: the page renders.

import { redirect } from "@tanstack/react-router";
import { fetchAccessState } from "./session";

/** The subset of the session user the shell actually renders. */
export interface GuardUser {
  email: string;
}

/**
 * Resolve the user for a page that requires sign-in when sign-in exists.
 *
 * Returns `{ user: null }` on an unrestricted deployment — `ALLOWED_EMAIL_DOMAINS`
 * unset, no identity provider, dashboard open. Callers must treat `user` as
 * nullable; `Nav` already renders no email chip when it is absent.
 *
 * Redirects to `/login` only when access IS restricted and no session exists.
 * Redirecting on an open deployment would bounce forever, because `/login`
 * itself redirects back out when there is nothing to sign in to.
 */
export async function resolveUser(): Promise<{ user: GuardUser | null }> {
  const { restricted, session } = await fetchAccessState();
  if (!restricted) return { user: null };
  if (!session) {
    throw redirect({ to: "/login" });
  }
  return { user: session.user };
}
