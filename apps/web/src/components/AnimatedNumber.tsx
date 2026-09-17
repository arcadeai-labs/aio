// A count-up numeral for the headline metrics (issue #14, spec §9: "animated
// metric counters", "<200ms run-switch transitions"). The figure rolls from the
// old number to the new one like a ticker rather than hard-cutting.
//
// Three constraints shape the implementation:
//   - SSR/hydration: the motion value is seeded with the real value, so the first
//     server + client render emit the same formatted text (no mismatch, no flash
//     of "0").
//   - Reduced motion: honored via useReducedMotion — the figure simply snaps.
//   - **A tween may never cross a cohort** (issue #23). See below.
// The first mount does NOT count up (that would need a 0→value flash that fights
// hydration); the motion is reserved for a value moving inside one cohort.
//
// ── Why `snapshot` is required ───────────────────────────────────────────────
//
// Every caller renders this figure above a caption naming the cohort it is a
// figure *of*: "91.7%" over "33 of 36". The caption is ordinary React text, so it
// swaps in the commit the new loader data arrives. The figure is a framer-motion
// value written to the DOM outside React, so it lagged that commit and then
// interpolated toward the new number — for ~400ms the tile printed the previous
// cohort's rate directly above the new cohort's denominator. Measured on the
// seeded corpus: 37.5% (Global) over "33 of 36" (Branded, really 91.7%) — a
// 54-point error that looks like a reading, not like an error.
//
// Worse, the interpolated frames belong to no cohort at all: "74.7% over 33 of
// 36" was never true of anything.
//
// So `snapshot` names the cohort this value was computed over — segment, run,
// theme, whatever scopes it. When it changes, the ticker is *remounted*: the
// motion value is re-seeded from the new value in the same commit that swaps the
// caption, and the first-mount rule above makes that a clean cut rather than a
// tween. A mounted ticker therefore only ever displays numbers from one cohort,
// and the figure/caption pair cannot disagree in any frame.
//
// Making it a required prop is the enforcement: a new call site cannot silently
// inherit the bug, it has to say which cohort its number belongs to.
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "framer-motion";
import { useEffect, useRef } from "react";

interface TickerProps {
  /** The numeric value to display; null renders the placeholder (no animation). */
  value: number | null;
  /** Formats the live (interpolating) number into display text, e.g. "62.5%". */
  format: (n: number) => string;
  className?: string;
  placeholder?: string;
}

export function AnimatedNumber({
  snapshot,
  ...props
}: TickerProps & {
  /**
   * Identity of the cohort `value` was computed over — e.g.
   * `"branded·2026-09-14"`. Must change whenever the caption beside this figure
   * changes, and must not change otherwise.
   */
  snapshot: string;
}) {
  // The key is the whole fix: a cohort change is a remount, not a transition.
  return <Ticker key={snapshot} {...props} />;
}

function Ticker({ value, format, className, placeholder = "—" }: TickerProps) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(value ?? 0);
  const text = useTransform(mv, (n) => format(n));
  const first = useRef(true);

  useEffect(() => {
    if (value === null) return;
    // Skip the initial mount — only animate when the value actually changes
    // within one cohort. First paint already shows the correct number, and after
    // a cohort switch this *is* the first mount, so the switch cuts.
    if (first.current) {
      first.current = false;
      mv.set(value);
      return;
    }
    if (reduce) {
      mv.set(value);
      return;
    }
    const controls = animate(mv, value, {
      duration: 0.45,
      ease: [0.16, 1, 0.3, 1],
    });
    return () => controls.stop();
  }, [value, reduce, mv]);

  if (value === null) return <span className={className}>{placeholder}</span>;
  return <motion.span className={className}>{text}</motion.span>;
}
