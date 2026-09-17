import { describe, expect, test } from "bun:test";
import { isSyntheticConfig } from "../src/config.js";

// `isSyntheticConfig` reads a value that arrives from a `jsonb` column as
// `unknown`, and both directions of getting it wrong are silent:
//
//   - too loose, and a run with no flag (every run ingested before the flag
//     existed — real measurements) gets labelled invented, which teaches readers
//     to ignore the marker and so breaks the case it exists for;
//   - too strict, and a seeded corpus renders unmarked.
//
// So the whole shape of the input space is asserted here, not just the happy path.

describe("isSyntheticConfig — absent must read as not-synthetic", () => {
  test("a config with no synthetic key is not synthetic", () => {
    expect(isSyntheticConfig({ brand: { name: "Taskwell" } })).toBe(false);
  });

  test("a missing snapshot (undefined / null raw) is not synthetic", () => {
    expect(isSyntheticConfig(undefined)).toBe(false);
    expect(isSyntheticConfig(null)).toBe(false);
  });

  test("an explicit false is not synthetic", () => {
    expect(isSyntheticConfig({ synthetic: false })).toBe(false);
  });

  test("truthy non-booleans are not synthetic", () => {
    // A hand-edited config is the likely source of these. `"false"` is the one
    // that matters most: it is truthy, so a `!!raw.synthetic` check would read a
    // config that says "not synthetic" as synthetic.
    expect(isSyntheticConfig({ synthetic: "false" })).toBe(false);
    expect(isSyntheticConfig({ synthetic: "true" })).toBe(false);
    expect(isSyntheticConfig({ synthetic: 1 })).toBe(false);
    expect(isSyntheticConfig({ synthetic: {} })).toBe(false);
  });

  test("non-objects are not synthetic and do not throw", () => {
    expect(isSyntheticConfig("synthetic")).toBe(false);
    expect(isSyntheticConfig(42)).toBe(false);
    expect(isSyntheticConfig(true)).toBe(false);
  });
});

describe("isSyntheticConfig — the flagged case", () => {
  test("the boolean true is synthetic", () => {
    expect(isSyntheticConfig({ synthetic: true })).toBe(true);
  });

  test("the shipped seed-matched config is synthetic", async () => {
    // The promise the feature rests on: a user who runs `bun run seed` never has
    // to remember to turn the marker on. If this file ever loses the flag, a
    // seeded dashboard goes back to presenting invented rankings of real
    // competitors with nothing to indicate it.
    const config = await Bun.file(
      new URL("../../../analytics.config.example.json", import.meta.url),
    ).json();
    expect(isSyntheticConfig(config)).toBe(true);
  });
});
