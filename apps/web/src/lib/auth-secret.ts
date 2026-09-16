// Resolves the session signing secret better-auth is configured with, and
// decides what to do when nobody supplied one.
//
// ── Why this file exists ─────────────────────────────────────────────────────
//
// `apps/web/Dockerfile` sets `NODE_ENV=production`, so better-auth's own
// `validateSecret` throws when it falls back to its built-in default secret.
// That throw happens the first time the auth module is imported, which is the
// first time a page renders — not at boot. The result on a fresh clone with no
// `.env` was a container that logged `aio web listening on :3000`, reported
// `RestartCount=0`, answered `/` with a 307, and then died mid-request on the
// redirect target. Every page: unreachable. Every symptom: something other than
// "a variable is missing". See issue #20.
//
// `docker compose up --build` reaching a rendered dashboard is the promise
// README.md makes on its first screen, so the default path must not require the
// reader to hand-author a secret first.
//
// ── The access model, stated and checked ─────────────────────────────────────
//
// This is the part that must not be assumed, because being wrong here is not a
// wrong number on a chart.
//
// `ALLOWED_EMAIL_DOMAINS` is the switch for the whole access model (DESIGN.md
// §10, `lib/auth.ts`). With it unset:
//
//   - `accessRestricted` is false.
//   - `lib/route-guard.ts` returns `{ user: null }` and never redirects to
//     `/login`; `/login` itself redirects away.
//   - `lib/require-session.ts` — the data boundary every server function calls
//     — returns before it ever looks at a session.
//   - No social provider is registered (`signInEnabled` in `lib/auth.ts`), so
//     no sign-in can be started, and both database hooks deny outright, so no
//     session can be minted even if one were.
//
// So in the default configuration there is no sign-in flow, no session, and
// nothing the signing secret protects. An ephemeral secret there costs exactly
// one thing — sessions that would not survive a restart — and there are no
// sessions. That is why generating one is safe *there specifically*.
//
// The fourth bullet is the load-bearing one, and it was FALSE when this file
// was first written. Provider registration keyed off the Google credentials
// alone, so a deployment with `ALLOWED_EMAIL_DOMAINS` unset and
// `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` set — an ordinary developer `.env`
// — answered `POST /api/auth/sign-in/social` with 200 and a live
// accounts.google.com authorize URL, and the callback could mint a session
// signed by the ephemeral secret generated below. The premise had to become
// true rather than the conclusion softened: `signInEnabled` now requires the
// same switch, and `apps/web/test/auth-session-gate.test.ts` drives the public
// `/api/auth/*` route with the Google variables SET to prove it.
//
// Do not weaken this to "require a real secret when OAuth is configured". That
// would keep a sign-in path alive in a mode the rest of the system believes is
// unauthenticated, where an empty domain list means every Google account on
// earth is admissible. The secret is not the thing to fix.
//
// The moment `ALLOWED_EMAIL_DOMAINS` is set, every clause above inverts:
// sessions are real, they carry identity, and they gate data. A per-process
// random secret would then silently log everyone out on each restart, and would
// differ between replicas behind a load balancer — a signing key nobody chose,
// protecting people who think they are protected. So we do not generate one
// there. We refuse, loudly, naming the variable and the file.
//
// The rule, in one line: **generate only where the generated secret protects
// nothing.** That condition is passed in and checked below, not assumed.

import { randomBytes } from "node:crypto";

/**
 * Prefix stamped onto every generated secret.
 *
 * The generated value has to be unmistakable wherever it surfaces — a log line,
 * `docker inspect`, a `session` row, a support paste. A bare random string
 * looks exactly like a deliberately-provisioned one, which is the failure this
 * whole file exists to avoid, so the value says what it is in words.
 */
export const EPHEMERAL_SECRET_PREFIX =
  "insecure-ephemeral-dev-secret-DO-NOT-USE-IN-PRODUCTION-";

/** True when `value` came from {@link generateEphemeralSecret}. */
export function isEphemeralSecret(value: string): boolean {
  return value.startsWith(EPHEMERAL_SECRET_PREFIX);
}

/** A fresh, unmistakably-labelled throwaway secret. */
export function generateEphemeralSecret(): string {
  return EPHEMERAL_SECRET_PREFIX + randomBytes(32).toString("hex");
}

/**
 * Thrown when access control is on but no secret was supplied.
 *
 * Carries the variable name and the file to set it in, because the error a
 * deployer sees at 3am is the whole user interface of this failure.
 */
export class MissingAuthSecretError extends Error {
  constructor() {
    super(
      "BETTER_AUTH_SECRET is not set, but ALLOWED_EMAIL_DOMAINS is — so this " +
        "deployment issues real sessions and must sign them with a secret you " +
        "chose. Refusing to invent one: a per-process random secret would log " +
        "every user out on each restart and would differ between replicas. " +
        "Set BETTER_AUTH_SECRET in .env (see .env.example), for example:\n" +
        "    BETTER_AUTH_SECRET=$(openssl rand -base64 32)",
    );
    this.name = "MissingAuthSecretError";
  }
}

const WARNING_LINES = [
  "BETTER_AUTH_SECRET is not set.",
  "",
  "Generated a random EPHEMERAL secret for this process only. It is",
  "NOT production-safe: it is thrown away and regenerated on every",
  "restart, and every replica would get a different one.",
  "",
  "This is harmless here only because ALLOWED_EMAIL_DOMAINS is unset,",
  "so there is no sign-in flow and no session for it to protect — the",
  "dashboard is OPEN to anyone who can reach it.",
  "",
  "Before exposing this beyond your own machine, set",
  "BETTER_AUTH_SECRET in .env (see .env.example):",
  "    BETTER_AUTH_SECRET=$(openssl rand -base64 32)",
];

// Boxed so it survives a wall of container logs, and padded programmatically
// because a hand-aligned box drifts the first time anyone edits a line.
const WARNING = (() => {
  const width = Math.max(...WARNING_LINES.map((l) => l.length)) + 4;
  const rule = "─".repeat(width);
  const body = WARNING_LINES.map((line) => `  │  ${line.padEnd(width - 4)}  │`);
  return ["", `  ┌${rule}┐`, ...body, `  └${rule}┘`, ""].join("\n");
})();

export interface ResolveAuthSecretOptions {
  /** Raw `BETTER_AUTH_SECRET`. Compose passes `""` when the human has no `.env`. */
  supplied: string | undefined;
  /**
   * Whether this deployment gates access at all — i.e. `ALLOWED_EMAIL_DOMAINS`
   * is set. This is the check that makes generating a secret safe; it is a
   * parameter rather than a module-level read so the rule is testable.
   */
  accessRestricted: boolean;
  /** Injected so tests can assert the warning fires, and name the variable. */
  warn?: (message: string) => void;
}

/**
 * Decide the secret better-auth signs sessions with.
 *
 * - A supplied non-blank value always wins, and is used silently.
 * - No value + access unrestricted → a labelled ephemeral secret, plus a loud
 *   warning naming `BETTER_AUTH_SECRET`. Nothing is protected, so nothing is
 *   lost; the fresh clone renders.
 * - No value + access restricted → {@link MissingAuthSecretError}. Real
 *   sessions must not be signed by a key nobody chose.
 *
 * Blank and whitespace-only values count as absent: `docker-compose.yml` passes
 * `${BETTER_AUTH_SECRET:-}`, so "unset on the host" arrives here as `""`.
 */
export function resolveAuthSecret(options: ResolveAuthSecretOptions): string {
  const { supplied, accessRestricted, warn = console.warn } = options;

  const trimmed = supplied?.trim();
  if (trimmed) return trimmed;

  if (accessRestricted) throw new MissingAuthSecretError();

  warn(WARNING);
  return generateEphemeralSecret();
}
