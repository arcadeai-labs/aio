import { describe, expect, test } from "bun:test";
import { createRng, seedFrom } from "../src/seed/rng.js";

/**
 * The PRNG exists so determinism is structural: `scenario` has no other source
 * of variation, so if this is reproducible the corpus is. These tests pin the
 * properties the corpus relies on — a stream that repeats for a seed, diverges
 * between seeds, and stays inside the bounds it was asked for.
 */
describe("createRng", () => {
  function draw(seed: string | number, n = 40): number[] {
    const rng = createRng(seed);
    return Array.from({ length: n }, () => rng.next());
  }

  test("the same seed replays the same stream", () => {
    expect(draw("taskwell")).toEqual(draw("taskwell"));
  });

  test("a different seed gives a different stream", () => {
    expect(draw("taskwell")).not.toEqual(draw("taskwell-2"));
  });

  test("accepts a numeric seed as well as a string", () => {
    expect(draw(12345)).toEqual(draw(12345));
    expect(draw(12345)).not.toEqual(draw(12346));
  });

  test("next() stays in [0, 1)", () => {
    const rng = createRng("bounds");
    for (let i = 0; i < 5000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test("int() is inclusive at both ends and never escapes them", () => {
    const rng = createRng("ints");
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const v = rng.int(1, 3);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(3);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([1, 2, 3]);
  });

  test("int(n, n) is the only value it can return", () => {
    const rng = createRng("degenerate");
    for (let i = 0; i < 100; i++) expect(rng.int(7, 7)).toBe(7);
  });

  test("chance() honours the impossible and the certain", () => {
    const rng = createRng("chance");
    for (let i = 0; i < 500; i++) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }
  });

  test("chance() lands near the requested rate over many draws", () => {
    const rng = createRng("rate");
    let hits = 0;
    for (let i = 0; i < 20_000; i++) if (rng.chance(0.3)) hits++;
    expect(hits / 20_000).toBeGreaterThan(0.27);
    expect(hits / 20_000).toBeLessThan(0.33);
  });

  test("pick() only returns members, and reaches all of them", () => {
    const rng = createRng("pick");
    const items = ["a", "b", "c", "d"] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(rng.pick(items));
    expect([...seen].sort()).toEqual(["a", "b", "c", "d"]);
  });

  test("pick() on an empty array fails loudly rather than returning undefined", () => {
    expect(() => createRng("empty").pick([])).toThrow(
      "cannot pick from an empty array",
    );
  });

  test("sample() draws without replacement, in the source's own order", () => {
    const rng = createRng("sample");
    const items = ["a", "b", "c", "d", "e"];
    for (let i = 0; i < 200; i++) {
      const got = rng.sample(items, 3);
      expect(got.length).toBe(3);
      expect(new Set(got).size).toBe(3);
      // Order preserved: the drawn subset is still ascending within `items`.
      const positions = got.map((v) => items.indexOf(v));
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    }
  });

  test("sample() asked for more than it has returns everything, once", () => {
    const items = ["a", "b"];
    expect(createRng("over").sample(items, 9)).toEqual(["a", "b"]);
  });

  test("hex() returns lowercase hex of the requested length", () => {
    const rng = createRng("hex");
    for (const n of [1, 3, 4, 8, 12]) {
      expect(rng.hex(n)).toMatch(new RegExp(`^[0-9a-f]{${n}}$`));
    }
  });
});

describe("seedFrom", () => {
  test("is stable and fits in 32 unsigned bits", () => {
    const h = seedFrom("aio-tracer");
    expect(seedFrom("aio-tracer")).toBe(h);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(2 ** 32);
  });

  test("separates seeds that differ by one character", () => {
    expect(seedFrom("seed-a")).not.toBe(seedFrom("seed-b"));
  });
});
