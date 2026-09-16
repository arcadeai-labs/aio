// No session can be minted while `ALLOWED_EMAIL_DOMAINS` is unset.
//
// This is the invariant `lib/auth-secret.ts` stakes its whole design on: the
// generated ephemeral secret is only safe because there is nothing for it to
// sign. It was false. Provider registration keyed off the Google credentials
// alone, so a deployment with the domains unset and `GOOGLE_CLIENT_ID` /
// `GOOGLE_CLIENT_SECRET` set — an ordinary developer `.env`, including the one
// on the machine this repo is developed on — answered
// `POST /api/auth/sign-in/social` with **200 and a live accounts.google.com
// authorize URL**, and the callback could create a user and a session.
//
// So every scenario below sets the Google variables. A test that left them out
// would only prove the default clone has no OAuth client configured, which was
// never in doubt and is not what broke.
//
// Each scenario runs in its own process (see fixtures/auth-route-probe.ts):
// `lib/auth.ts` reads its environment once at module load, so configurations
// cannot be compared inside one test process without the module cache handing
// back the first one.
//
// No database is required, deliberately. The refusals all happen before any
// query, so this suite cannot degrade into a skip on a machine without
// Postgres — and the unreachable `DATABASE_URL` below doubles as proof that
// the gate does not depend on the database being up. A gate that fails open
// when Postgres is down is not a gate.

import { describe, expect, test } from "bun:test";

interface ProbeResult {
  status: number;
  body: string;
  setCookie: string[];
  location: string | null;
}

interface Probes {
  registeredSocialProviders: string[];
  sessionHook: string;
  signInSocial: ProbeResult;
  callback: ProbeResult;
  getSession: ProbeResult;
}

const PROBE = new URL("./fixtures/auth-route-probe.ts", import.meta.url)
  .pathname;

/** Fake, but well-formed: no credential is needed to prove this, or exists. */
const GOOGLE_VARS_SET = {
  GOOGLE_CLIENT_ID: "fake-client-id-for-tests",
  GOOGLE_CLIENT_SECRET: "fake-client-secret-for-tests",
};

/**
 * Boot the auth route in a fresh process under `env` and collect its probes.
 *
 * `DATABASE_URL` points at a closed port on purpose — see the file header.
 */
async function bootAndProbe(env: Record<string, string>): Promise<Probes> {
  const child = Bun.spawn(["bun", "run", PROBE], {
    env: {
      ...process.env,
      ALLOWED_EMAIL_DOMAINS: "",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      BETTER_AUTH_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "test-only-secret-000000000000000000000000",
      DATABASE_URL: "postgres://unreachable:unreachable@127.0.0.1:1/nodb",
      DATABASE_SSL: "disable",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(child.stdout).text();
  const line = stdout.split("\n").find((l) => l.startsWith("__PROBE__"));
  if (!line) {
    const stderr = await new Response(child.stderr).text();
    throw new Error(
      `probe produced no result.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  return JSON.parse(line.slice("__PROBE__".length));
}

/** Every Set-Cookie the route emitted across every probe. */
function allCookies(probes: Probes): string[] {
  return [
    ...probes.signInSocial.setCookie,
    ...probes.callback.setCookie,
    ...probes.getSession.setCookie,
  ];
}

describe("access switch OFF, Google credentials SET — the broken configuration", () => {
  const boot = () => bootAndProbe({ ...GOOGLE_VARS_SET });

  test("registers no social provider", async () => {
    expect((await boot()).registeredSocialProviders).toEqual([]);
  });

  test("POST /api/auth/sign-in/social cannot start a sign-in", async () => {
    const { signInSocial } = await boot();
    expect(signInSocial.status).toBe(404);
    expect(signInSocial.body).toContain("PROVIDER_NOT_FOUND");
    // The regression, stated as the thing that must not come back.
    expect(signInSocial.body).not.toContain("accounts.google.com");
    expect(signInSocial.status).not.toBe(200);
  });

  test("the OAuth callback issues no session", async () => {
    const { callback } = await boot();
    expect(callback.setCookie).toEqual([]);
    expect(callback.body).not.toContain("session");
  });

  test("GET /api/auth/get-session reports no session", async () => {
    const { getSession } = await boot();
    expect(getSession.status).toBe(200);
    expect(getSession.body).toBe("null");
  });

  test("no request anywhere in the flow sets a cookie", async () => {
    // The single assertion that matters most: a session that is never signed
    // is a session the ephemeral secret never protected.
    expect(allCookies(await boot())).toEqual([]);
  });

  test("session.create.before refuses, naming the variable", async () => {
    // Belt to the provider gate's braces: even if a provider were added later
    // without re-reading lib/auth.ts, issuance itself still refuses.
    const { sessionHook } = await boot();
    expect(sessionHook).toStartWith("refused:");
    expect(sessionHook).toContain("ALLOWED_EMAIL_DOMAINS");
  });

  test("refuses without reaching the database", async () => {
    // DATABASE_URL points at a closed port. A refusal that mentioned a
    // connection error would mean the gate depends on Postgres being up.
    const { sessionHook } = await boot();
    expect(sessionHook).not.toContain("ECONNREFUSED");
  });
});

describe("access switch ON, same Google credentials — the control", () => {
  // Without this, every assertion above is explained just as well by "the fake
  // credentials were rejected". Same fake credentials, switch flipped, opposite
  // outcome: the switch is what decides.
  const boot = () =>
    bootAndProbe({ ...GOOGLE_VARS_SET, ALLOWED_EMAIL_DOMAINS: "example.com" });

  test("registers Google", async () => {
    expect((await boot()).registeredSocialProviders).toEqual(["google"]);
  });

  test("session.create.before proceeds to look the owner up", async () => {
    // It gets as far as the database (unreachable here, by construction), which
    // is how we know the refusal above was the access switch and not a blanket
    // "this hook always throws".
    const { sessionHook } = await boot();
    expect(sessionHook).not.toContain("ALLOWED_EMAIL_DOMAINS is not set");
  });
});

describe("access switch OFF, no Google credentials — the default clone", () => {
  const boot = () => bootAndProbe({});

  test("registers no social provider and mints no session", async () => {
    const probes = await boot();
    expect(probes.registeredSocialProviders).toEqual([]);
    expect(probes.getSession.body).toBe("null");
    expect(allCookies(probes)).toEqual([]);
  });
});
