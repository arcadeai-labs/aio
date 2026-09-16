// Corpus discovery + file hashing + streaming JSONL parsing. The only I/O layer
// of the reconciler. Reads canonical `results-DATE.jsonl` / `analysis-DATE.jsonl`
// from the repo's results/analysis dirs.
//
// `.bak` files are ignored structurally: the discovery regex matches the exact
// `results-DATE.jsonl` filename, so `results-DATE.jsonl.bak` never matches.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  type ResultVerdict,
  type UnifiedResult,
  stripNulChars,
} from "@aio/core";

const RESULTS_RE = /^results-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const ANALYSIS_RE = /^analysis-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface DiscoveredRun {
  runDate: string;
  resultsPath: string;
  analysisPath: string | null;
}

/**
 * Discover dated runs from the results + analysis directories. A run requires a
 * `results-DATE.jsonl`; its `analysis-DATE.jsonl` is attached when present.
 * `.bak` and any other non-canonical filename is ignored. Sorted by date.
 */
export async function discoverRuns(
  resultsDir: string,
  analysisDir: string,
): Promise<DiscoveredRun[]> {
  const resultsByDate = new Map<string, string>();
  for (const name of await safeReaddir(resultsDir)) {
    const m = name.match(RESULTS_RE);
    if (m) resultsByDate.set(m[1], join(resultsDir, name));
  }

  const analysisByDate = new Map<string, string>();
  for (const name of await safeReaddir(analysisDir)) {
    const m = name.match(ANALYSIS_RE);
    if (m) analysisByDate.set(m[1], join(analysisDir, name));
  }

  return [...resultsByDate.entries()]
    .map(([runDate, resultsPath]) => ({
      runDate,
      resultsPath,
      analysisPath: analysisByDate.get(runDate) ?? null,
    }))
    .sort((a, b) => a.runDate.localeCompare(b.runDate));
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Stream-hash a file's contents as sha256 hex (constant memory). */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Stream-parse a JSONL file, yielding each non-blank line's parsed object. */
async function parseJsonl<T>(path: string): Promise<T[]> {
  const rl = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  const out: T[] = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed) out.push(stripNulChars(JSON.parse(trimmed)) as T);
  }
  return out;
}

export function parseResults(path: string): Promise<UnifiedResult[]> {
  return parseJsonl<UnifiedResult>(path);
}

export function parseVerdicts(path: string): Promise<ResultVerdict[]> {
  return parseJsonl<ResultVerdict>(path);
}
