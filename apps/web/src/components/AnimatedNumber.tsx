// A count-up numeral for the headline metrics (issue #14, spec §9: "animated
// metric counters", "<200ms run-switch transitions"). When the run switches, the
// loader feeds a new value while this stays mounted, so the figure rolls from the
// old number to the new one like a ticker rather than hard-cutting.
//
// Two constraints shape the implementation:
//   - SSR/hydration: the motion value is seeded with the real value, so the first
//     server + client render emit the same formatted text (no mismatch, no flash
//     of "0").
//   - Reduced motion: honored via useReducedMotion — the figure simply snaps.
// The first mount does NOT count up (that would need a 0→value flash that fights
// hydration); the motion is reserved for the meaningful moment, a run change.
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "framer-motion";
import { useEffect, useRef } from "react";

export function AnimatedNumber({
  value,
  format,
  className,
  placeholder = "—",
}: {
  /** The numeric value to display; null renders the placeholder (no animation). */
  value: number | null;
  /** Formats the live (interpolating) number into display text, e.g. "62.5%". */
  format: (n: number) => string;
  className?: string;
  placeholder?: string;
}) {
  const reduce = useReducedMotion();
  const mv = useMotionValue(value ?? 0);
  const text = useTransform(mv, (n) => format(n));
  const first = useRef(true);

  useEffect(() => {
    if (value === null) return;
    // Skip the initial mount — only animate when the value actually changes
    // (a run switch). First paint already shows the correct number.
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
