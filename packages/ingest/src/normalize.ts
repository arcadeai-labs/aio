// Prompt identity. A prompt's identity is hash(normalized_text), where
// normalization = trim + collapse internal whitespace + lowercase. Cosmetic
// drift (spacing/case) maps to the SAME id; a genuine rewording is intentionally
// a NEW prompt. See DASHBOARD_SPEC.md §4.

import { createHash } from "node:crypto";

/** trim + collapse internal whitespace to single spaces + lowercase. */
export function normalizePromptText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Stable prompt identity: sha256(normalizePromptText(text)) as hex. */
export function promptId(text: string): string {
  return createHash("sha256").update(normalizePromptText(text)).digest("hex");
}

/** Source `promptMeta.brandedType` ("Branded"/"Unbranded") → canonical lower. */
export function normalizeBrandedType(
  raw: string | undefined | null,
): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  return v === "branded" || v === "unbranded" ? v : null;
}

/** Parse the comma-joined `promptMeta.labels` into trimmed, de-duped labels. */
export function parseLabels(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const label = part.trim();
    if (label) seen.add(label);
  }
  return [...seen];
}
