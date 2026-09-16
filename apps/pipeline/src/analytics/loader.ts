import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { UnifiedResult } from "../types/unified-result.js";
import type { ResultVerdict } from "./types.js";

export async function loadResults(
  resultsDir: string,
  date: string,
): Promise<UnifiedResult[]> {
  const filePath = join(resultsDir, `results-${date}.jsonl`);
  return readJsonl<UnifiedResult>(filePath);
}

export async function loadVerdicts(
  outputDir: string,
  date: string,
): Promise<ResultVerdict[]> {
  const filePath = join(outputDir, `analysis-${date}.jsonl`);
  return readJsonl<ResultVerdict>(filePath);
}

export async function findPreviousAnalysisDate(
  outputDir: string,
  currentDate: string,
): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(outputDir);
  } catch {
    return null;
  }

  const analysisDates = files
    .filter((f) => f.startsWith("analysis-") && f.endsWith(".jsonl"))
    .map((f) => f.replace("analysis-", "").replace(".jsonl", ""))
    .filter((d) => d < currentDate)
    .sort()
    .reverse();

  return analysisDates[0] ?? null;
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  const content = await readFile(filePath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}
