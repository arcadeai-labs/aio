/**
 * A seeded PRNG for the demo corpus.
 *
 * It exists so determinism is *structural* rather than something a contributor
 * has to remember: `scenario` takes an `Rng` and has no other source of
 * variation, so the only way to make its output non-reproducible is to stop
 * passing one. Nothing here touches `Math.random`.
 *
 * mulberry32 — a 32-bit state, statistically fine for scattering demo numbers
 * and short enough to read in one sitting. It is not cryptographic and nothing
 * in this project asks it to be.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** True with probability `p` (p <= 0 never, p >= 1 always). */
  chance(p: number): boolean;
  /** Uniform element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** `count` distinct elements, in the array's own order, without replacement. */
  sample<T>(items: readonly T[], count: number): T[];
  /** Lowercase hex string of `length` characters. */
  hex(length: number): string;
}

/**
 * Hash an arbitrary seed string to the 32-bit integer mulberry32 wants, so
 * `SEED=taskwell` and `SEED=12345` are both usable. Numeric strings still go
 * through the hash; there is no reason for the caller to care which it gave.
 */
export function seedFrom(seed: string): number {
  // FNV-1a, 32-bit.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createRng(seed: string | number): Rng {
  let state = (typeof seed === "number" ? seed : seedFrom(seed)) >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number =>
    min + Math.floor(next() * (max - min + 1));

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) {
      throw new Error("rng.pick: cannot pick from an empty array");
    }
    return items[int(0, items.length - 1)];
  };

  const sample = <T>(items: readonly T[], count: number): T[] => {
    const wanted = Math.min(count, items.length);
    // Draw indices, not a shuffled copy, so the caller's order survives — a
    // week's citation list reads like a list of sources, not a reshuffle.
    const chosen = new Set<number>();
    // Every iteration consumes exactly one draw regardless of collisions, so
    // the stream position depends only on `items.length` and `count`.
    const order: number[] = [];
    for (let i = 0; i < items.length; i++) order.push(i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = int(0, i);
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const idx of order.slice(0, wanted)) chosen.add(idx);
    return items.filter((_, i) => chosen.has(i));
  };

  const hex = (length: number): string => {
    let out = "";
    while (out.length < length) out += int(0, 15).toString(16);
    return out.slice(0, length);
  };

  return {
    next,
    int,
    chance: (p) => next() < p,
    pick,
    sample,
    hex,
  };
}
