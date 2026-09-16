// better-auth server instance — Google OAuth, sessions in Postgres, and the
// optional email-domain access gate.
//
// Access control is OFF by default. With `ALLOWED_EMAIL_DOMAINS` unset the
// dashboard is open to anyone who can reach it, which is what makes a fresh
// clone useful with nothing but `docker compose up` — no Google Cloud project,
// no OAuth client, no identity provider. Set the variable to a comma-separated
// domain list to turn sign-in on.
//
// The gate decision itself lives in `@aio/core` (`evaluateAccess`) as a pure
// function so it can be unit-tested exhaustively without the OAuth flow. Here we
// wire that decision into better-auth at two points:
//
//   1. user.create.before  — blocks a *new* account whose verified email is not
//      on an allowed domain. No user row (and therefore no session) can ever
//      exist without passing this, so it is the primary gate.
//   2. session.create.before — re-checks the owning user on *every* session
//      issuance (defense in depth: covers returning users and any later email
//      drift), so a session is never minted for a disallowed principal.
//
// Both hooks are no-ops when access is unrestricted. They are still registered
// rather than conditionally omitted, so that turning the gate on is purely a
// matter of configuration and never a different code path.
//
// We deliberately do NOT set better-auth's `hd` option. Setting it makes
// better-auth *enforce* the Google `hd` (hosted-domain) claim, but `hd` is
// spoofable by a self-hosted IdP and can be absent for legitimately-migrated
// accounts — so trusting it would be both insufficient and over-restrictive.
// The verified-email check is the sole gate; `hd` is, at most, a UI hint.

import {
  evaluateAccess,
  isAccessRestricted,
  parseAllowedDomains,
} from "@aio/core";
import { db, findUserAccessFields, schema } from "@aio/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";

/**
 * Domains permitted to sign in, parsed once at module load.
 *
 * Empty means unrestricted — see `accessRestricted` below.
 */
const allowedDomains = parseAllowedDomains(process.env.ALLOWED_EMAIL_DOMAINS);

/**
 * Whether this deployment gates access by email domain at all.
 *
 * Exported so route guards and the login screen can branch on it: when `false`
 * there is nothing to sign in to, and `/login` redirects away rather than
 * offering a button that cannot work.
 */
export const accessRestricted = isAccessRestricted(allowedDomains);

const DENIAL_MESSAGE = `Access is restricted to verified Google accounts on: ${allowedDomains.join(", ")}.`;

if (!accessRestricted) {
  console.warn(
    "[auth] ALLOWED_EMAIL_DOMAINS not set — the dashboard is OPEN to anyone " +
      "who can reach it. Set it to a comma-separated domain list (and " +
      "configure Google OAuth) before exposing this beyond localhost.",
  );
}

function denyUnlessAllowed(input: {
  email: string | null | undefined;
  emailVerified: boolean | null | undefined;
}): void {
  // Unrestricted deployments never consult the gate. Checked here rather than
  // inside `evaluateAccess` so that the gate itself fails closed on an empty
  // domain list: a typo in the env var must lock people out, not let them in.
  if (!accessRestricted) return;
  if (!evaluateAccess(input, allowedDomains).allowed) {
    // 403 — surfaced to the client as a failed sign-in, not a 500.
    throw new APIError("FORBIDDEN", { message: DENIAL_MESSAGE });
  }
}

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
// Only register the Google provider when fully configured. Registering it with
// an empty clientId makes the authorize-URL build throw an opaque 500; leaving
// it unregistered instead yields a clean "provider not found" response and lets
// the app boot for everything except the actual sign-in click.
const googleConfigured = Boolean(googleClientId && googleClientSecret);
if (!googleConfigured) {
  console.warn(
    "[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google sign-in is " +
      "disabled until both are provided (see .env.example).",
  );
}

export const auth = betterAuth({
  // baseURL is required in production (set BETTER_AUTH_URL to the custom domain);
  // in local dev better-auth falls back to the request origin.
  baseURL: process.env.BETTER_AUTH_URL,
  // Session signing secret. Required in production; better-auth warns and uses a
  // dev fallback when unset locally.
  secret: process.env.BETTER_AUTH_SECRET,

  database: drizzleAdapter(db, {
    provider: "pg",
    // Map better-auth's models to our Drizzle tables (snake_case columns, the
    // camelCase JS keys better-auth expects). Passing the schema explicitly
    // avoids any reliance on table-name pluralization heuristics.
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),

  // Email/password is disabled: the only way in is verified Google SSO.
  emailAndPassword: { enabled: false },

  socialProviders: googleConfigured
    ? {
        google: {
          clientId: googleClientId as string,
          clientSecret: googleClientSecret as string,
        },
      }
    : {},

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          // `user.emailVerified` is populated from Google's `email_verified`
          // claim by the provider's profile mapping.
          denyUnlessAllowed({
            email: user.email,
            emailVerified: user.emailVerified,
          });
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const owner = await findUserAccessFields(session.userId);
          denyUnlessAllowed({
            email: owner?.email,
            emailVerified: owner?.emailVerified,
          });
        },
      },
    },
  },
});

/** Typed session shape inferred from the configured auth instance. */
export type Session = typeof auth.$Infer.Session;
