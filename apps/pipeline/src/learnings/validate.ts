// Record validation for the learnings contract. Every record is validated here
// before it is written, so the downstream dashboard always receives well-formed
// slots. LLM-free and deterministic.

import {
  LEARNING_CONFIDENCES,
  LEARNING_STATUSES,
  LEARNING_TIERS,
  type Learning,
} from "@aio/core";

export type ValidationResult =
  | { valid: true }
  | { valid: false; errors: string[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isScalar(v: unknown): v is string | number {
  return (
    (typeof v === "string" && v.length > 0) ||
    (typeof v === "number" && Number.isFinite(v))
  );
}

/**
 * Validate an arbitrary value against the Learning contract. Returns the full
 * list of problems (not just the first) so a malformed generator output is easy
 * to debug.
 *
 * Status semantics enforced here:
 * - `ok` must cite at least one piece of evidence (the hard "cite evidence"
 *   guardrail applies to real findings).
 * - `nothing_notable` / `unavailable` may carry empty evidence.
 */
export function validateLearning(value: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof value !== "object" || value === null) {
    return { valid: false, errors: ["record must be an object"] };
  }
  const r = value as Record<string, unknown>;

  if (!isNonEmptyString(r.slug)) errors.push("slug must be a non-empty string");
  if (!LEARNING_TIERS.includes(r.tier as never))
    errors.push(`tier must be one of ${LEARNING_TIERS.join(", ")}`);
  if (!isNonEmptyString(r.runDate) || !DATE_RE.test(r.runDate as string))
    errors.push("runDate must be a YYYY-MM-DD string");
  if (!LEARNING_STATUSES.includes(r.status as never))
    errors.push(`status must be one of ${LEARNING_STATUSES.join(", ")}`);
  if (!isNonEmptyString(r.headline))
    errors.push("headline must be a non-empty string");
  if (!isNonEmptyString(r.body)) errors.push("body must be a non-empty string");
  if (!LEARNING_CONFIDENCES.includes(r.confidence as never))
    errors.push(`confidence must be one of ${LEARNING_CONFIDENCES.join(", ")}`);
  if (!isNonEmptyString(r.generator))
    errors.push("generator must be a non-empty string");
  if (!isNonEmptyString(r.generatedAt))
    errors.push("generatedAt must be a non-empty string");

  if (!Array.isArray(r.evidence)) {
    errors.push("evidence must be an array");
  } else {
    r.evidence.forEach((e, i) => {
      if (typeof e !== "object" || e === null) {
        errors.push(`evidence[${i}] must be an object`);
        return;
      }
      const ev = e as Record<string, unknown>;
      if (!isNonEmptyString(ev.label))
        errors.push(`evidence[${i}].label must be a non-empty string`);
      if (!isScalar(ev.value))
        errors.push(`evidence[${i}].value must be a string or number`);
      if (ev.delta !== undefined && !isScalar(ev.delta))
        errors.push(
          `evidence[${i}].delta must be a string or number when present`,
        );
      if (!isNonEmptyString(ev.source))
        errors.push(`evidence[${i}].source must be a non-empty string`);
    });

    if (r.status === "ok" && r.evidence.length === 0)
      errors.push("an 'ok' learning must cite at least one piece of evidence");
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/** Narrowing assertion used at the write boundary. */
export function assertValidLearning(value: unknown): asserts value is Learning {
  const result = validateLearning(value);
  if (!result.valid) {
    throw new Error(
      `learning record failed validation:\n- ${result.errors.join("\n- ")}`,
    );
  }
}
