// The data boundary. Every server function that returns dashboard data calls
// this before touching the database.
//
// Route guards are UX — they decide what to render. This is authorization: it
// decides what leaves the server. The two are deliberately separate, so that a
// bypassed or buggy guard yields a blank page rather than someone else's data.
//
// It exists as one function because it used to be seven copies of the same
// four lines, one per server function. Turning access control into a
// configurable thing meant changing all seven identically, and the failure mode
// of missing one is asymmetric: miss it with the gate ON and that endpoint
// serves data to anyone.

import { getRequest } from "@tanstack/react-start/server";
import { accessRestricted, auth } from "./auth";

/**
 * Authorize a server-side data request.
 *
 * Throws `Unauthorized` when this deployment gates access and the caller has no
 * session. Returns silently when `ALLOWED_EMAIL_DOMAINS` is unset — an
 * unrestricted deployment has no sessions at all, so requiring one would make
 * every page fail with a 500 rather than render openly.
 */
export async function requireSession(): Promise<void> {
  if (!accessRestricted) return;
  const { headers } = getRequest();
  const session = await auth.api.getSession({ headers });
  if (!session) {
    throw new Error("Unauthorized");
  }
}
