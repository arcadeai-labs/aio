import { describe, expect, test } from "bun:test";
import {
  type AccessGateInput,
  evaluateAccess,
  isAccessRestricted,
  isAllowedUser,
  parseAllowedDomains,
} from "../src/auth-gate.js";

// These tests exercise the access decision in isolation from the OAuth flow:
// the gate is a pure function of (email, emailVerified, allowedDomains), so the
// full allow/deny matrix can be asserted directly without standing up Google, a
// session, or an environment variable.

const ALLOWED = ["example.com"];

const verified = (email: string): AccessGateInput => ({
  email,
  emailVerified: true,
});

describe("parseAllowedDomains", () => {
  test.each([undefined, null, "", "   ", ",", " , , "])(
    "%p yields an empty list",
    (raw) => {
      expect(parseAllowedDomains(raw)).toEqual([]);
    },
  );

  test("splits, trims, lowercases and strips a leading @", () => {
    expect(parseAllowedDomains(" @Example.com, partner.DEV ")).toEqual([
      "example.com",
      "partner.dev",
    ]);
  });

  test("drops empty entries from trailing or doubled commas", () => {
    expect(parseAllowedDomains("example.com,,partner.dev,")).toEqual([
      "example.com",
      "partner.dev",
    ]);
  });
});

describe("isAccessRestricted", () => {
  test("an empty list means the dashboard is open", () => {
    expect(isAccessRestricted([])).toBe(false);
  });

  test("any configured domain restricts access", () => {
    expect(isAccessRestricted(ALLOWED)).toBe(true);
  });
});

describe("evaluateAccess — allow", () => {
  test("verified address on an allowed domain is allowed", () => {
    expect(evaluateAccess(verified("ada@example.com"), ALLOWED)).toEqual({
      allowed: true,
    });
  });

  test("is case-insensitive on the whole address", () => {
    expect(isAllowedUser(verified("Ada@Example.COM"), ALLOWED)).toBe(true);
  });

  test("tolerates surrounding whitespace", () => {
    expect(isAllowedUser(verified("  ada@example.com \n"), ALLOWED)).toBe(true);
  });

  test("a quoted local part containing @ still resolves to the real domain", () => {
    // The last '@' delimits the domain; the local part is allowed to contain one.
    expect(isAllowedUser(verified('"weird@thing"@example.com'), ALLOWED)).toBe(
      true,
    );
  });

  test("any domain in a multi-domain list is accepted", () => {
    const multi = parseAllowedDomains("example.com, partner.dev");
    expect(isAllowedUser(verified("ada@example.com"), multi)).toBe(true);
    expect(isAllowedUser(verified("grace@partner.dev"), multi)).toBe(true);
  });
});

describe("evaluateAccess — fails closed on an empty domain list", () => {
  // The open-dashboard path is `isAccessRestricted`, checked by the caller
  // BEFORE the gate. Reaching the gate with no configured domains means the
  // config is wrong, and the gate must deny rather than wave everyone through.
  test("a verified address is denied when no domains are configured", () => {
    expect(evaluateAccess(verified("ada@example.com"), [])).toEqual({
      allowed: false,
      reason: "domain_not_allowed",
    });
  });
});

describe("evaluateAccess — deny on verification", () => {
  test("allowed domain but emailVerified=false is denied", () => {
    expect(
      evaluateAccess(
        { email: "ada@example.com", emailVerified: false },
        ALLOWED,
      ),
    ).toEqual({ allowed: false, reason: "email_unverified" });
  });

  test.each([
    undefined,
    null,
    "true" as unknown as boolean,
    1 as unknown as boolean,
  ])("non-true emailVerified (%p) is treated as unverified", (value) => {
    expect(
      evaluateAccess(
        { email: "ada@example.com", emailVerified: value as boolean },
        ALLOWED,
      ),
    ).toEqual({ allowed: false, reason: "email_unverified" });
  });
});

describe("evaluateAccess — deny on missing email", () => {
  test.each([undefined, null, "", "   "])(
    "empty email (%p) is denied",
    (value) => {
      expect(
        evaluateAccess({ email: value, emailVerified: true }, ALLOWED),
      ).toEqual({ allowed: false, reason: "missing_email" });
    },
  );

  test("an address with no @ is denied as wrong domain", () => {
    expect(evaluateAccess(verified("not-an-email"), ALLOWED)).toEqual({
      allowed: false,
      reason: "domain_not_allowed",
    });
  });
});

describe("evaluateAccess — deny on domain look-alikes", () => {
  // The crux of the gate: only an EXACT domain match is allowed. Each of these
  // would slip past a naive `endsWith`/`includes`/subdomain check.
  const lookAlikes = [
    "attacker@evil.example.com", // subdomain of example.com
    "attacker@example.com.evil.com", // example.com as a left-label of another domain
    "attacker@notexample.com", // suffix match on "example.com"
    "attacker@example.company.com", // shares the "example.com" prefix
    "attacker@example.com@evil.com", // last @ wins -> evil.com
    "attacker@xexample.com", // prefix glued on
    "attacker@example.com.", // trailing dot
    "attacker@examplexcom", // missing dot
    "attacker@gmail.com", // unrelated domain
    "attacker@example.dev", // right name, wrong TLD
  ];

  test.each(lookAlikes)("rejects %s", (email) => {
    expect(evaluateAccess(verified(email), ALLOWED)).toEqual({
      allowed: false,
      reason: "domain_not_allowed",
    });
  });
});

describe("evaluateAccess — rule ordering", () => {
  test("verification is checked before domain (unverified allowed-domain -> unverified)", () => {
    const result = evaluateAccess(
      { email: "ada@example.com", emailVerified: false },
      ALLOWED,
    );
    expect(result).toEqual({ allowed: false, reason: "email_unverified" });
  });

  test("missing email is reported before verification", () => {
    expect(
      evaluateAccess({ email: null, emailVerified: false }, ALLOWED),
    ).toEqual({ allowed: false, reason: "missing_email" });
  });
});
