// Server-side session read, exposed as a server function so route loaders can
// resolve the current user on the server (and over RPC on the client).
//
// This is the data-boundary check: any future server function that returns
// private data MUST re-resolve the session here (or via middleware) rather than
// trusting a route guard — guards are UX, not authorization.
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { accessRestricted, auth } from "./auth";

/**
 * Resolve the current better-auth session from the request cookies.
 * Returns `{ user, session }` when signed in, or `null` otherwise.
 */
export const fetchSession = createServerFn({ method: "GET" }).handler(
  async () => {
    const { headers } = getRequest();
    return auth.api.getSession({ headers });
  },
);

/**
 * Resolve both the session and whether this deployment gates access at all.
 *
 * Route guards need both facts together. `accessRestricted` is derived from
 * `ALLOWED_EMAIL_DOMAINS`, which only exists on the server, so it has to cross
 * the RPC boundary alongside the session rather than being read in the route.
 *
 * When `restricted` is `false` the dashboard is open: guards must not redirect
 * to `/login`, because there is no sign-in flow to complete.
 */
export const fetchAccessState = createServerFn({ method: "GET" }).handler(
  async () => {
    const { headers } = getRequest();
    return {
      restricted: accessRestricted,
      session: accessRestricted ? await auth.api.getSession({ headers }) : null,
    };
  },
);
