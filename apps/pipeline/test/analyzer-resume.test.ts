import { describe, expect, test } from "bun:test";
import { dedupeVerdicts } from "../src/analytics/analyzer.js";
import type { ResultVerdict } from "../src/analytics/types.js";

function verdict(resultId: string, analyzedAt: string): ResultVerdict {
  return { resultId, analyzedAt } as unknown as ResultVerdict;
}

describe("dedupeVerdicts", () => {
  test("keeps the most recently judged copy of each resultId", () => {
    const byId = dedupeVerdicts([
      verdict("a", "2026-08-26T16:00:00.000Z"),
      verdict("b", "2026-08-26T16:00:00.000Z"),
      verdict("a", "2026-08-27T12:00:00.000Z"),
    ]);

    expect(byId.size).toBe(2);
    expect(byId.get("a")?.analyzedAt).toBe("2026-08-27T12:00:00.000Z");
  });

  test("keeps an older verdict when it is the only copy", () => {
    const byId = dedupeVerdicts([
      verdict("a", "2026-08-26T16:00:00.000Z"),
      verdict("b", "2026-08-27T12:00:00.000Z"),
    ]);

    expect(byId.get("a")?.analyzedAt).toBe("2026-08-26T16:00:00.000Z");
  });

  test("drops verdicts judged before the rejudge cutoff", () => {
    const byId = dedupeVerdicts(
      [
        verdict("a", "2026-08-26T16:00:00.000Z"),
        verdict("b", "2026-08-27T12:00:00.000Z"),
      ],
      "2026-08-27T00:00:00.000Z",
    );

    expect(byId.has("a")).toBe(false);
    expect(byId.has("b")).toBe(true);
  });

  test("ignores an out-of-order append that arrives after a newer verdict", () => {
    const byId = dedupeVerdicts([
      verdict("a", "2026-08-27T12:00:00.000Z"),
      verdict("a", "2026-08-26T16:00:00.000Z"),
    ]);

    expect(byId.get("a")?.analyzedAt).toBe("2026-08-27T12:00:00.000Z");
  });
});
