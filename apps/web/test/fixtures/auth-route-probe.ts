// Boots the real auth route under whatever environment it is spawned with, runs
// a fixed set of probes through it, and prints the results as JSON on stdout.
//
// It exists as a separate process because `lib/auth.ts` reads its environment
// once, at module load, exactly as a container does. Re-importing it inside one
// test process would hand back the cached module and quietly test a single
// configuration several times — the kind of green that means nothing. One
// process per configuration is the only honest way to compare them.
//
// Nothing here touches the database. With the access switch off the sign-in
// path refuses before any query, and the probes that would otherwise query
// (a real OAuth round trip) are not among them — so `DATABASE_URL` can be the
// same unreachable placeholder the Dockerfile uses for the SSR build, and this
// suite can never degrade to a skip for want of a Postgres.
//
// Usage (see auth-session-gate.test.ts):
//   ALLOWED_EMAIL_DOMAINS=… GOOGLE_CLIENT_ID=… bun run auth-route-probe.ts

import { auth } from "../../src/lib/auth";
import { Route } from "../../src/routes/api/auth/$";

/** What one probe of the public route observed. */
export interface ProbeResult {
  status: number;
  /** Truncated — enough to identify a provider error or an authorize URL. */
  body: string;
  /** Every Set-Cookie header. A session leaks through here or not at all. */
  setCookie: string[];
  location: string | null;
}

const handlers = Route.options.server?.handlers as {
  GET: (ctx: { request: Request }) => Promise<Response>;
  POST: (ctx: { request: Request }) => Promise<Response>;
};

async function probe(request: Request): Promise<ProbeResult> {
  // Deliberately the route's own handler, not `auth.handler`: the route is the
  // public surface, and a test that skipped it could not see a route-level
  // mistake.
  const method = request.method === "POST" ? "POST" : "GET";
  const response = await handlers[method]({ request });
  return {
    status: response.status,
    body: (await response.text()).slice(0, 600),
    setCookie: response.headers.getSetCookie(),
    location: response.headers.get("location"),
  };
}

/** Whether the `session.create.before` hook admits a principal, by message. */
async function sessionHookVerdict(): Promise<string> {
  const before = auth.options.databaseHooks?.session?.create?.before;
  if (!before) return "hook-not-registered";
  try {
    // A userId that does not exist: with the switch off the hook must refuse
    // before it ever looks the user up, so this never reaches the database.
    await before({ userId: "no-such-user" } as never);
    return "admitted";
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  }
}

const origin = "http://localhost:3000";

const results = {
  /**
   * Which social providers the constructed instance actually registered.
   *
   * Read off the real `auth` object rather than asserted about the source, so
   * that the comparison across configurations is a comparison of behaviour.
   */
  registeredSocialProviders: Object.keys(auth.options.socialProviders ?? {}),
  sessionHook: await sessionHookVerdict(),
  /** Start a Google sign-in. The step that used to hand back an authorize URL. */
  signInSocial: await probe(
    new Request(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
    }),
  ),
  /** The OAuth callback — where a user row and a session would be created. */
  callback: await probe(
    new Request(
      `${origin}/api/auth/callback/google?code=fake-authorization-code&state=fake-state`,
    ),
  ),
  /** Whatever the server believes the caller's session is. */
  getSession: await probe(new Request(`${origin}/api/auth/get-session`)),
};

console.log(`__PROBE__${JSON.stringify(results)}`);

// better-auth keeps handles open; nothing here needs a graceful close.
process.exit(0);
