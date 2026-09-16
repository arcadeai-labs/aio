import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_TARGETS } from "./targets.js";
import type { PromptEntry, TargetEntry } from "./types/config.js";
import { loadCsv } from "./util/csv-loader.js";
import { logger } from "./util/logger.js";

/**
 * Shared prompt/target loading used by the main run (index.ts) and the
 * fill-missing run (run-missing.ts). Keeping this in one place guarantees both
 * reconstruct the identical prompt × target matrix — a fill run can only tell
 * what's missing if it builds the expected set exactly as the main run did.
 */

/**
 * Load and normalize prompts from a CSV, applying the same relevance filter and
 * theme_name/category remapping the main run uses. Returns the PromptEntry list
 * in the same shape the runner consumes.
 */
export async function loadPrompts(promptsFile: string): Promise<PromptEntry[]> {
  const rows = await loadCsv(promptsFile);
  if (rows.length === 0) return [];

  // Filter out non-relevant rows. A prompts CSV may carry a "Relevant" column
  // to park rows without deleting them; anything else is treated as relevant.
  const relevant = rows.filter((row) => {
    const val = row.Relevant;
    if (val === undefined || val === "") return true;
    return val.toUpperCase() !== "FALSE";
  });

  if (relevant.length < rows.length) {
    logger.info(
      {
        total: rows.length,
        relevant: relevant.length,
        skipped: rows.length - relevant.length,
      },
      "Filtered non-relevant prompts",
    );
  }

  return relevant.map((row) => {
    const {
      prompt,
      category,
      theme_name,
      Relevant: _relevant,
      "Reason for not relevant": _reason,
      ...rest
    } = row;

    // If theme_name exists, use it as category (it's the meaningful grouping).
    // Move original category (Branded/Unbranded) into meta.
    const effectiveCategory = theme_name || category || undefined;

    const meta: Record<string, string> = { ...rest };
    if (theme_name && category) {
      meta.brandedType = category;
    }

    return {
      prompt,
      category: effectiveCategory,
      meta: Object.keys(meta).length > 0 ? meta : undefined,
    };
  });
}

/**
 * Load the provider/model target matrix. Uses TARGETS_FILE (JSON) if set,
 * otherwise the DEFAULT_TARGETS source of truth.
 */
export async function loadTargets(): Promise<TargetEntry[]> {
  const targetsFile = process.env.TARGETS_FILE;
  if (!targetsFile) return DEFAULT_TARGETS;
  const raw = await readFile(resolve(targetsFile), "utf-8");
  return JSON.parse(raw) as TargetEntry[];
}
