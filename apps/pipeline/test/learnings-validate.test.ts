import { describe, expect, test } from "bun:test";
import type { Learning } from "@aio/core";
import {
  assertValidLearning,
  validateLearning,
} from "../src/learnings/validate.js";

function learning(overrides: Partial<Learning> = {}): Learning {
  return {
    slug: "movers",
    tier: "structured",
    runDate: "2026-06-22",
    status: "ok",
    headline: "Mentions ticked up while accuracy held steady",
    body: "Brand mentions rose by 10 week-over-week, the clearest positive mover.",
    evidence: [
      {
        label: "Results mentioning the brand",
        value: "1363",
        delta: "+10",
        source: "comparison-2026-06-22.json",
      },
    ],
    confidence: "medium",
    generator: "movers@openai:gpt-5.2",
    generatedAt: "2026-06-22T12:00:00.000Z",
    ...overrides,
  };
}

describe("validateLearning — well-formed", () => {
  test("accepts a complete ok record", () => {
    expect(validateLearning(learning())).toEqual({ valid: true });
  });

  test("accepts evidence without a delta", () => {
    const r = learning({
      evidence: [
        {
          label: "Total results",
          value: 3198,
          source: "comparison-2026-06-22.json",
        },
      ],
    });
    expect(validateLearning(r)).toEqual({ valid: true });
  });

  test("accepts nothing_notable with empty evidence", () => {
    const r = learning({ status: "nothing_notable", evidence: [] });
    expect(validateLearning(r)).toEqual({ valid: true });
  });

  test("accepts unavailable with empty evidence", () => {
    const r = learning({ status: "unavailable", evidence: [] });
    expect(validateLearning(r)).toEqual({ valid: true });
  });
});

describe("validateLearning — malformed", () => {
  test("rejects a non-object", () => {
    expect(validateLearning(null).valid).toBe(false);
    expect(validateLearning("x").valid).toBe(false);
  });

  test("rejects a bad status / tier / confidence enum", () => {
    const r = validateLearning(
      learning({
        // @ts-expect-error intentionally invalid
        status: "great",
        // @ts-expect-error intentionally invalid
        tier: "manual",
        // @ts-expect-error intentionally invalid
        confidence: "certain",
      }),
    );
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.startsWith("status"))).toBe(true);
      expect(r.errors.some((e) => e.startsWith("tier"))).toBe(true);
      expect(r.errors.some((e) => e.startsWith("confidence"))).toBe(true);
    }
  });

  test("rejects a non-ISO runDate", () => {
    const r = validateLearning(learning({ runDate: "June 22" }));
    expect(r.valid).toBe(false);
  });

  test("rejects an empty headline or body", () => {
    expect(validateLearning(learning({ headline: "  " })).valid).toBe(false);
    expect(validateLearning(learning({ body: "" })).valid).toBe(false);
  });

  test("requires an ok record to cite evidence", () => {
    const r = validateLearning(learning({ status: "ok", evidence: [] }));
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes("cite at least one"))).toBe(true);
    }
  });

  test("rejects malformed evidence items", () => {
    const r = validateLearning(
      learning({
        // @ts-expect-error intentionally invalid evidence shape
        evidence: [{ label: "", value: {}, source: "" }],
      }),
    );
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.errors.some((e) => e.includes("evidence[0].label"))).toBe(true);
      expect(r.errors.some((e) => e.includes("evidence[0].value"))).toBe(true);
      expect(r.errors.some((e) => e.includes("evidence[0].source"))).toBe(true);
    }
  });

  test("collects all errors rather than only the first", () => {
    const r = validateLearning({ slug: "", tier: "x", status: "y" });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors.length).toBeGreaterThan(3);
  });
});

describe("assertValidLearning", () => {
  test("returns void for a valid record", () => {
    expect(() => assertValidLearning(learning())).not.toThrow();
  });

  test("throws with the joined error list for an invalid record", () => {
    expect(() => assertValidLearning(learning({ headline: "" }))).toThrow(
      /failed validation/,
    );
  });
});
