import { describe, expect, test } from "bun:test";
import {
  normalizeBrandedType,
  normalizePromptText,
  parseLabels,
  promptId,
} from "../src/normalize.js";

describe("prompt identity normalization", () => {
  test("collapses cosmetic drift to the same id (whitespace/case/trim)", () => {
    const canonical = "What are the best AI agent auth platforms?";
    const drifted = [
      "  What are the best AI agent auth platforms?  ", // leading/trailing
      "What  are   the best AI agent auth platforms?", // collapsed internal ws
      "WHAT ARE THE BEST AI AGENT AUTH PLATFORMS?", // case
      "What are the best AI agent auth platforms?\n", // trailing newline
    ];
    const base = promptId(canonical);
    for (const variant of drifted) {
      expect(promptId(variant)).toBe(base);
    }
  });

  test("genuine rewording is a distinct prompt", () => {
    const a = promptId("What are the best AI agent auth platforms?");
    const b = promptId("Which auth platforms are best for AI agents?");
    expect(a).not.toBe(b);
  });

  test("punctuation is significant (not stripped by normalization)", () => {
    // Normalization only trims/collapses/lowercases — it does NOT strip
    // punctuation, so a trailing '?' vs '.' is a different prompt.
    expect(promptId("best auth platforms?")).not.toBe(
      promptId("best auth platforms."),
    );
  });

  test("normalizePromptText is trim + collapse + lowercase", () => {
    expect(normalizePromptText("  Foo   Bar\tBaz \n")).toBe("foo bar baz");
  });

  test("ids are stable sha256 hex (64 chars)", () => {
    expect(promptId("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("branded_type normalization", () => {
  test("maps source casing to canonical lowercase", () => {
    expect(normalizeBrandedType("Branded")).toBe("branded");
    expect(normalizeBrandedType("Unbranded")).toBe("unbranded");
    expect(normalizeBrandedType("  UNBRANDED ")).toBe("unbranded");
  });

  test("unknown/empty → null", () => {
    expect(normalizeBrandedType(undefined)).toBeNull();
    expect(normalizeBrandedType(null)).toBeNull();
    expect(normalizeBrandedType("")).toBeNull();
    expect(normalizeBrandedType("mystery")).toBeNull();
  });
});

describe("label parsing", () => {
  test("splits comma-joined labels, trims, de-dupes", () => {
    expect(
      parseLabels("KEYWORDS_HIGH_IMPORTANCE, KEYWORDS_OTHER, SALES_COMPANY"),
    ).toEqual(["KEYWORDS_HIGH_IMPORTANCE", "KEYWORDS_OTHER", "SALES_COMPANY"]);
    expect(parseLabels("a, a , b")).toEqual(["a", "b"]);
    expect(parseLabels("")).toEqual([]);
    expect(parseLabels(undefined)).toEqual([]);
  });
});
