// Behaviour of the session-secret resolver (#20).
//
// The bug this guards against is not a crash you would see — it is a container
// that boots, logs "listening", serves one redirect, and then dies on the first
// render. So these tests assert the two halves of the rule that replaced it:
// generate where the secret protects nothing, refuse where it protects someone.

import { describe, expect, test } from "bun:test";
import {
  EPHEMERAL_SECRET_PREFIX,
  MissingAuthSecretError,
  generateEphemeralSecret,
  isEphemeralSecret,
  resolveAuthSecret,
} from "../src/lib/auth-secret";

/** Collects warnings so a test can assert what a reader would actually see. */
function recorder() {
  const lines: string[] = [];
  return { warn: (m: string) => lines.push(m), text: () => lines.join("\n") };
}

describe("resolveAuthSecret — a supplied secret", () => {
  test("is used verbatim when access is open", () => {
    const log = recorder();
    const secret = resolveAuthSecret({
      supplied: "chosen-by-a-human",
      accessRestricted: false,
      warn: log.warn,
    });
    expect(secret).toBe("chosen-by-a-human");
    expect(log.text()).toBe("");
  });

  test("is used verbatim when access is restricted", () => {
    const log = recorder();
    const secret = resolveAuthSecret({
      supplied: "chosen-by-a-human",
      accessRestricted: true,
      warn: log.warn,
    });
    expect(secret).toBe("chosen-by-a-human");
    expect(log.text()).toBe("");
  });

  test("is trimmed, because .env values pick up trailing whitespace", () => {
    expect(
      resolveAuthSecret({
        supplied: "  padded  ",
        accessRestricted: true,
        warn: () => {},
      }),
    ).toBe("padded");
  });

  test("is never mistaken for a generated one", () => {
    const secret = resolveAuthSecret({
      supplied: "chosen-by-a-human",
      accessRestricted: false,
      warn: () => {},
    });
    expect(isEphemeralSecret(secret)).toBe(false);
  });
});

describe("resolveAuthSecret — no secret, access OPEN", () => {
  // ALLOWED_EMAIL_DOMAINS unset: no sign-in flow, no session, nothing the
  // secret protects. This is the fresh-clone path README.md promises.

  test("returns a usable secret rather than throwing", () => {
    const secret = resolveAuthSecret({
      supplied: undefined,
      accessRestricted: false,
      warn: () => {},
    });
    expect(secret.length).toBeGreaterThan(EPHEMERAL_SECRET_PREFIX.length);
  });

  test("treats compose's empty passthrough as absent", () => {
    // docker-compose.yml passes `${BETTER_AUTH_SECRET:-}`, so a host with no
    // .env delivers "" here, not undefined. Getting this wrong reinstates #20.
    for (const supplied of ["", "   ", "\n"]) {
      const secret = resolveAuthSecret({
        supplied,
        accessRestricted: false,
        warn: () => {},
      });
      expect(isEphemeralSecret(secret)).toBe(true);
    }
  });

  test("labels the secret so it cannot be mistaken for production-safe", () => {
    const secret = resolveAuthSecret({
      supplied: undefined,
      accessRestricted: false,
      warn: () => {},
    });
    expect(secret).toContain("insecure");
    expect(secret).toContain("DO-NOT-USE-IN-PRODUCTION");
    expect(isEphemeralSecret(secret)).toBe(true);
  });

  test("warns, and the warning names BETTER_AUTH_SECRET", () => {
    const log = recorder();
    resolveAuthSecret({
      supplied: undefined,
      accessRestricted: false,
      warn: log.warn,
    });
    const text = log.text();
    expect(text).toContain("BETTER_AUTH_SECRET");
    expect(text).toContain("EPHEMERAL");
    expect(text).toContain("NOT production-safe");
    // The reader must be told how to fix it, not just that it is wrong.
    expect(text).toContain("openssl rand -base64 32");
    expect(text).toContain(".env");
  });

  test("generates a different secret every time", () => {
    // Per-process and unpredictable: a constant would be a committed secret
    // wearing a warning label, which is worse than no secret at all.
    const seen = new Set(
      Array.from({ length: 20 }, () =>
        resolveAuthSecret({
          supplied: undefined,
          accessRestricted: false,
          warn: () => {},
        }),
      ),
    );
    expect(seen.size).toBe(20);
  });
});

describe("resolveAuthSecret — no secret, access RESTRICTED", () => {
  // ALLOWED_EMAIL_DOMAINS set: sessions are real and carry identity. A
  // per-process secret would log everyone out on restart and differ between
  // replicas, so we refuse instead of inventing one.

  test("throws rather than generating", () => {
    expect(() =>
      resolveAuthSecret({
        supplied: undefined,
        accessRestricted: true,
        warn: () => {},
      }),
    ).toThrow(MissingAuthSecretError);
  });

  test("throws on a blank value too", () => {
    expect(() =>
      resolveAuthSecret({
        supplied: "   ",
        accessRestricted: true,
        warn: () => {},
      }),
    ).toThrow(MissingAuthSecretError);
  });

  test("the message names the variable and where to set it", () => {
    let message = "";
    try {
      resolveAuthSecret({
        supplied: undefined,
        accessRestricted: true,
        warn: () => {},
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("BETTER_AUTH_SECRET");
    expect(message).toContain("ALLOWED_EMAIL_DOMAINS");
    expect(message).toContain(".env");
    expect(message).toContain("openssl rand -base64 32");
  });

  test("does not warn — a refusal is not a warning", () => {
    const log = recorder();
    expect(() =>
      resolveAuthSecret({
        supplied: undefined,
        accessRestricted: true,
        warn: log.warn,
      }),
    ).toThrow();
    expect(log.text()).toBe("");
  });
});

describe("generateEphemeralSecret", () => {
  test("is long enough to sign with", () => {
    // 32 random bytes as hex.
    const secret = generateEphemeralSecret();
    expect(secret.slice(EPHEMERAL_SECRET_PREFIX.length)).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  test("round-trips through isEphemeralSecret", () => {
    expect(isEphemeralSecret(generateEphemeralSecret())).toBe(true);
    expect(isEphemeralSecret("better-auth-secret-123456789")).toBe(false);
  });
});
