// better-auth server instance — Google OAuth, sessions in Postgres, and the
// optional email-domain access gate.
//
// Access control is OFF by default. With `ALLOWED_EMAIL_DOMAINS` unset the
// dashboard is open to anyone who can reach it, which is what makes a fresh
// clone useful with nothing but `docker compose up` — no Google Cloud project,
// no OAuth client, no identity provider. Set the variable to a comma-separated
// domain list to turn sign-in on.
//
// `ALLOWED_EMAIL_DOMAINS` is the ONLY switch. "Off" means no provider is
// registered and no session can be minted — not merely that nothing is checked.
// Supplying Google credentials does not turn sign-in on by itself; see
// `signInEnabled`. Everything else in the app already assumed this (the route
// guard, the data boundary, `/login`, and ci.yml's "Login redirects away when
// access is unrestricted"), while this file did not — which is how an open
// deployment could hand out real sessions to any Google account.
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
// Both hooks DENY when access is unrestricted, rather than passing. An empty
// domain list admits nobody — `evaluateAccess` already fails closed on one, and
// a hook that waved principals through on the same input would invert that. In
// a correctly-configured deployment neither hook is reachable with the switch
// off, because no provider is registered; they deny anyway so that adding a
// provider later cannot quietly re-open the hole.
//
// They are registered unconditionally, so that turning the gate on is purely a
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
import { resolveAuthSecret } from "./auth-secret";

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

const NO_SIGN_IN_MESSAGE =
  "Sign-in is disabled: ALLOWED_EMAIL_DOMAINS is not set, so this deployment " +
  "has no access model to admit anyone under.";

/**
 * Refuse any principal on an unrestricted deployment, then apply the gate.
 *
 * The first clause is the one that matters. "Unrestricted" does not mean
 * "anyone may sign in" — it means *nobody signs in*, because there is no
 * domain list to admit them under and `evaluateAccess` fails closed on an
 * empty one. Letting a principal through here would hand a session to any
 * Google account on earth, which is the opposite of what an empty allow-list
 * should produce.
 *
 * This is belt to `signInEnabled`'s braces: with the switch off no provider is
 * registered, so neither hook should be reachable at all. They deny anyway, so
 * that a future provider added without re-reading this file cannot quietly
 * mint sessions.
 */
function denyUnlessAllowed(input: {
  email: string | null | undefined;
  emailVerified: boolean | null | undefined;
}): void {
  if (!accessRestricted) {
    throw new APIError("FORBIDDEN", { message: NO_SIGN_IN_MESSAGE });
  }
  if (!evaluateAccess(input, allowedDomains).allowed) {
    // 403 — surfaced to the client as a failed sign-in, not a 500.
    throw new APIError("FORBIDDEN", { message: DENIAL_MESSAGE });
  }
}

/**
 * Session signing secret.
 *
 * Resolved before `betterAuth()` so the image's `NODE_ENV=production` can never
 * reach better-auth's own default-secret throw, which fired lazily on the first
 * render and killed the process mid-request (#20). `lib/auth-secret.ts` carries
 * the access-model reasoning for why generating one is safe when — and only
 * when — `ALLOWED_EMAIL_DOMAINS` is unset.
 */
const authSecret = resolveAuthSecret({
  supplied: process.env.BETTER_AUTH_SECRET,
  accessRestricted,
});

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleCredentialsPresent = Boolean(googleClientId && googleClientSecret);

/**
 * Whether a sign-in flow exists at all.
 *
 * Credentials are necessary but NOT sufficient: `ALLOWED_EMAIL_DOMAINS` is the
 * switch for the whole access model, and it gates provider registration too.
 *
 * It did not, and that was a real hole. With the domains unset but the Google
 * variables set — which is exactly the shape of a developer `.env` that once
 * had OAuth configured — `POST /api/auth/sign-in/social` returned **200 with a
 * live accounts.google.com authorize URL**, and the callback could create a
 * user and a session. Meanwhile `lib/route-guard.ts`, `lib/require-session.ts`
 * and `/login` all treat that same configuration as "no sign-in exists", and
 * `denyUnlessAllowed` had nothing to check against, so any Google account on
 * earth was admissible. The UI hid the door; the API left it open.
 *
 * So one switch now decides both, and `ci.yml`'s "Login redirects away when
 * access is unrestricted" step finally asserts something true of the whole
 * system rather than only of the UI.
 *
 * Registering with an empty clientId is separately avoided because it makes the
 * authorize-URL build throw an opaque 500; leaving the provider unregistered
 * yields a clean "provider not found" and lets everything else boot.
 */
const signInEnabled = accessRestricted && googleCredentialsPresent;

if (accessRestricted && !googleCredentialsPresent) {
  console.warn(
    "[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google sign-in is " +
      "disabled until both are provided (see .env.example).",
  );
}
if (!accessRestricted && googleCredentialsPresent) {
  // Worth saying out loud: these credentials look configured but do nothing.
  // Silence here is how someone concludes the dashboard is gated when it is not.
  console.warn(
    "[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are set but " +
      "ALLOWED_EMAIL_DOMAINS is not, so Google sign-in stays DISABLED and the " +
      "dashboard is OPEN to anyone who can reach it. Set ALLOWED_EMAIL_DOMAINS " +
      "to the domains you want to admit before relying on these credentials.",
  );
}

export const auth = betterAuth({
  // baseURL is required in production (set BETTER_AUTH_URL to the custom domain);
  // in local dev better-auth falls back to the request origin.
  baseURL: process.env.BETTER_AUTH_URL,
  // Always a real value — never better-auth's built-in default, which throws
  // under NODE_ENV=production. See `authSecret` above.
  secret: authSecret,

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

  socialProviders: signInEnabled
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
          // Refuse BEFORE the lookup, not after. With the switch off there is
          // no domain list to judge the owner against, so the query could only
          // ever end in the same refusal — and ordering it first means the
          // refusal does not depend on the database being reachable. A gate
          // that fails open when Postgres is down is not a gate.
          if (!accessRestricted) {
            throw new APIError("FORBIDDEN", { message: NO_SIGN_IN_MESSAGE });
          }
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
