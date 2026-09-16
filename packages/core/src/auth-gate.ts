// Authoritative server-side access gate for the dashboard.
//
// Access can be restricted to verified Google accounts on one or more email
// domains, configured through `ALLOWED_EMAIL_DOMAINS`. This module is the single
// source of truth for that decision and is kept pure (no OAuth, no DB, no env)
// so it can be unit-tested exhaustively and reused by any caller (better-auth
// hooks, route loaders, tests). Reading the environment is the caller's job —
// see `parseAllowedDomains`.
//
// The Google `hd` (hosted-domain) claim is NOT consulted here: it is a hint that
// can be spoofed by a self-hosted IdP, so the gate trusts only the verified
// email address. Callers may log `hd` for diagnostics, but it never decides.

export interface AccessGateInput {
  /** The account email as reported by the identity provider. */
  email: string | null | undefined;
  /** Whether the provider asserts the email address has been verified. */
  emailVerified: boolean | null | undefined;
}

export type AccessDenialReason =
  | "missing_email"
  | "email_unverified"
  | "domain_not_allowed";

export type AccessGateResult =
  | { allowed: true }
  | { allowed: false; reason: AccessDenialReason };

/**
 * Parse the `ALLOWED_EMAIL_DOMAINS` environment variable into a normalized list.
 *
 * Accepts a comma-separated list, tolerating the shapes people actually type:
 * surrounding whitespace, a leading `@`, and mixed case. For example
 * `" @Example.com, partner.dev "` yields `["example.com", "partner.dev"]`.
 *
 * An EMPTY result means no domain restriction is configured. It is deliberately
 * not an error and deliberately not a default-deny: this project ships with the
 * dashboard open so a fresh clone runs with no identity provider at all. The
 * decision of what "unrestricted" means belongs to the caller — see
 * {@link isAccessRestricted} — because making `evaluateAccess` silently allow
 * everything on an empty list would turn a config typo into an open door.
 */
export function parseAllowedDomains(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase().replace(/^@/, ""))
    .filter((part) => part.length > 0);
}

/**
 * Whether a configured domain list actually restricts anything.
 *
 * Callers use this to decide whether to mount the sign-in flow at all. When it
 * is `false` the dashboard is open and {@link evaluateAccess} is never consulted.
 */
export function isAccessRestricted(allowedDomains: readonly string[]): boolean {
  return allowedDomains.length > 0;
}

/**
 * Extract the domain of an email address as the substring after its LAST `@`.
 *
 * Using the last `@` (not the first) is deliberate: an address such as
 * `attacker@example.com@evil.com` has its real, routable domain as `evil.com`,
 * and a quoted local part like `"weird@thing"@example.com` resolves correctly to
 * `example.com`. Returns `null` when there is no `@` at all.
 */
function emailDomain(normalizedEmail: string): string | null {
  const at = normalizedEmail.lastIndexOf("@");
  if (at === -1) return null;
  return normalizedEmail.slice(at + 1);
}

/**
 * Evaluate whether an identity may access the dashboard, returning a structured
 * verdict (with a denial reason) for logging and tests.
 *
 * Rules, in order:
 *   1. An email must be present.
 *   2. The provider must assert the email is verified (`emailVerified === true`).
 *   3. The email's domain must EXACTLY equal one of `allowedDomains`
 *      (case-insensitive).
 *
 * Exact domain equality — rather than `endsWith('@example.com')` or
 * `includes('example.com')` — is what rejects subdomain and suffix look-alikes
 * such as `evil.example.com`, `example.com.evil.com`, and `notexample.com`.
 *
 * `allowedDomains` is a required parameter with no default. An empty list denies
 * everything here; callers that want an open dashboard must branch on
 * {@link isAccessRestricted} *before* reaching this function, so that a
 * misconfigured domain list fails closed rather than open.
 */
export function evaluateAccess(
  input: AccessGateInput,
  allowedDomains: readonly string[],
): AccessGateResult {
  const email = input.email?.trim().toLowerCase();
  if (!email) return { allowed: false, reason: "missing_email" };

  // Strict boolean check: a missing/`undefined`/truthy-but-not-`true` value is
  // treated as unverified rather than coerced.
  if (input.emailVerified !== true) {
    return { allowed: false, reason: "email_unverified" };
  }

  const domain = emailDomain(email);
  if (domain === null || !allowedDomains.includes(domain)) {
    return { allowed: false, reason: "domain_not_allowed" };
  }

  return { allowed: true };
}

/** Boolean convenience wrapper over {@link evaluateAccess}. */
export function isAllowedUser(
  input: AccessGateInput,
  allowedDomains: readonly string[],
): boolean {
  return evaluateAccess(input, allowedDomains).allowed;
}
