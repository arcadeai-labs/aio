// Postgres cannot store NUL (U+0000) in text or jsonb columns -- a single one
// anywhere in a row aborts the whole insert ("invalid byte sequence for
// encoding UTF8: 0x00"). LLM judges occasionally emit malformed unicode
// escapes containing it (observed 2026-07-13: "Knowledge\u0000b2" intended
// as "Knowledge\u00b2"), so every boundary that parses LLM-derived JSON
// strips it.

/** Recursively remove NUL characters from every string in a JSON-shaped value. */
export function stripNulChars<T>(value: T): T {
  if (typeof value === "string") {
    return value.replaceAll("\u0000", "") as T;
  }
  if (Array.isArray(value)) {
    return value.map(stripNulChars) as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[stripNulChars(k)] = stripNulChars(v);
    }
    return out as T;
  }
  return value;
}
