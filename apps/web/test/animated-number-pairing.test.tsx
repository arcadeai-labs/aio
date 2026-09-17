// Issue #23: a KPI tile must never render a figure and a caption that describe
// different cohorts.
//
// The defect was invisible in a settled render — before and after the transition
// the tile was correct, and for ~400ms in between it read "37.5%" (the Global
// mention rate) directly above "33 of 36" (the Branded denominator, whose real
// rate is 91.7%). A test that renders once and asserts the final text proves
// nothing about it. These tests sample the *rendered DOM over real time* across a
// cohort change, the way a reader's eye or a screenshot samples it.
//
// Nothing here is wrapped in `act`: act exists to flush updates to their settled
// state, which is exactly the state in which this bug is invisible. The tile is
// driven the way the browser drives it and read on a timer.
//
// The first test is the control, and it is not optional: it proves this harness
// can actually observe a tween. Without it, a framer-motion that silently did not
// animate under happy-dom would make the invariant tests pass while checking
// nothing — the same "green run that executed nothing" this project keeps
// rediscovering.
import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Conditional because `bun test` shares one process across files and a second
// registration throws — another render-level suite may have got here first.
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

// Imported after the DOM exists: react-dom/client binds to globals at import.
const { useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AnimatedNumber } = await import("../src/components/AnimatedNumber");

/** Real values from the seeded corpus, run 2026-09-14 — the pair in the bug
 * report. The gap between the two cohorts is 54.2 points, which is what makes a
 * mid-transition frame so legible and so wrong. */
const COHORTS = {
  global: { rate: 0.375, caption: "36 of 96 · All (error-free, pooled)" },
  branded: { rate: 0.917, caption: "33 of 36 · All (error-free, pooled)" },
} as const;
type CohortName = keyof typeof COHORTS;

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Every figure/caption pair a tile is allowed to show, as rendered text. */
const LEGAL_PAIRS = Object.values(COHORTS).map(
  (c) => `${pct(c.rate)} over ${c.caption}`,
);

/** The scoreboard tile, reduced to the two halves that must agree: a figure
 * rendered by AnimatedNumber and the caption naming its denominator. Both are
 * read from one cohort, exactly as `Metric` reads one snapshot. */
function Tile({
  initial,
  bind,
}: {
  initial: CohortName;
  bind: (set: (c: CohortName, rate?: number) => void) => void;
}) {
  const [cohort, setCohort] = useState<CohortName>(initial);
  const [rate, setRate] = useState<number>(COHORTS[initial].rate);
  bind((c, r) => {
    setCohort(c);
    setRate(r ?? COHORTS[c].rate);
  });
  return (
    <div className="metric">
      <AnimatedNumber
        className="metric__value"
        value={rate}
        format={pct}
        snapshot={cohort}
      />
      <p className="metric__cohort">{COHORTS[cohort].caption}</p>
    </div>
  );
}

interface Frame {
  t: number;
  figure: string;
  caption: string;
  pair: string;
}

/** Mounts the tile, applies `change`, then samples the rendered DOM every ~8ms
 * of real time for `ms`. */
async function sample(
  initial: CohortName,
  change: (set: (c: CohortName, rate?: number) => void) => void,
  ms = 700,
): Promise<Frame[]> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let set!: (c: CohortName, rate?: number) => void;

  root.render(
    <Tile
      initial={initial}
      bind={(s) => {
        set = s;
      }}
    />,
  );
  // Let the mount commit and its effects run before anything changes.
  await new Promise((r) => setTimeout(r, 50));

  const frames: Frame[] = [];
  const t0 = performance.now();
  change(set);
  while (performance.now() - t0 < ms) {
    const figure = host.querySelector(".metric__value")?.textContent ?? "";
    const caption = host.querySelector(".metric__cohort")?.textContent ?? "";
    frames.push({
      t: Math.round(performance.now() - t0),
      figure,
      caption,
      pair: `${figure} over ${caption}`,
    });
    await new Promise((r) => setTimeout(r, 8));
  }

  root.unmount();
  host.remove();
  return frames;
}

describe("the harness can see a tween (control)", () => {
  test("a value moving inside one cohort passes through intermediate frames", async () => {
    // Same cohort, same caption: nothing here is a lie, and the counter is free
    // to roll. If this stops observing intermediate values, the invariant tests
    // below have stopped testing anything.
    const frames = await sample("global", (set) => set("global", 0.917));
    const intermediate = [...new Set(frames.map((f) => f.figure))].filter(
      (v) => v !== pct(0.375) && v !== pct(0.917),
    );
    expect(intermediate.length).toBeGreaterThan(3);
    expect(frames[frames.length - 1]?.figure).toBe(pct(0.917));
  });
});

describe("a tile never pairs one cohort's figure with another's caption", () => {
  test("across a cohort change, every sampled frame is a real cohort's pair", async () => {
    const frames = await sample("global", (set) => set("branded"));
    expect(frames.length).toBeGreaterThan(20);

    const bad = frames.filter((f) => !LEGAL_PAIRS.includes(f.pair));
    expect(bad.map((f) => `t=${f.t}ms ${f.pair}`)).toEqual([]);
  });

  test("the switch is one step: no interpolated figure is ever displayed", async () => {
    // The numbers a tween invents mid-flight ("74.7% over 33 of 36") were true of
    // no cohort in any run, so the tile must step from one settled pair straight
    // to the other.
    const frames = await sample("global", (set) => set("branded"));
    const steps = frames
      .map((f) => f.pair)
      .filter((p, i, all) => i === 0 || p !== all[i - 1]);
    expect(steps.every((p) => LEGAL_PAIRS.includes(p))).toBe(true);
    expect(steps.length).toBeLessThanOrEqual(2);
  });

  test("and it lands on the new cohort", async () => {
    const frames = await sample("global", (set) => set("branded"));
    expect(frames[frames.length - 1]).toMatchObject({
      figure: pct(0.917),
      caption: COHORTS.branded.caption,
    });
  });
});
