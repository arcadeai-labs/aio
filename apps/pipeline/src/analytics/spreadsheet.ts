import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAnalyticsConfig } from "./config.js";
import { loadVerdicts } from "./loader.js";
import type { BrandRank, ResultVerdict } from "./types.js";

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(cells: string[]): string {
  return cells.map(csvEscape).join(",");
}

export function rankDisplay(rank: BrandRank): string {
  return rank === "not_ranked" ? "" : String(rank);
}

export async function findAllAnalysisDates(
  outputDir: string,
): Promise<string[]> {
  const files = await readdir(outputDir);
  return files
    .filter((f) => f.startsWith("analysis-") && f.endsWith(".jsonl"))
    .map((f) => f.replace("analysis-", "").replace(".jsonl", ""))
    .sort();
}

export type DetailKey = string; // "prompt\0provider\0model"
export function makeDetailKey(v: {
  prompt: string;
  provider: string;
  model: string;
}): DetailKey {
  return `${v.prompt}\0${v.provider}\0${v.model}`;
}

async function main() {
  const config = await loadAnalyticsConfig();
  const { outputDir } = config;

  const dates = await findAllAnalysisDates(outputDir);
  if (dates.length === 0) {
    console.log("No analysis files found.");
    return;
  }
  console.log(`Found ${dates.length} analysis date(s): ${dates.join(", ")}`);

  // Load all verdicts keyed by date
  const verdictsByDate = new Map<string, ResultVerdict[]>();
  for (const date of dates) {
    verdictsByDate.set(date, await loadVerdicts(outputDir, date));
  }

  // --- Detail CSV ---

  // Build map: detailKey → Map<date, ResultVerdict>
  const detailMap = new Map<DetailKey, Map<string, ResultVerdict>>();
  // Track metadata per key for sorting
  const detailMeta = new Map<
    DetailKey,
    { category: string; prompt: string; provider: string; model: string }
  >();

  for (const [date, verdicts] of verdictsByDate) {
    for (const v of verdicts) {
      const key = makeDetailKey(v);
      if (!detailMap.has(key)) {
        detailMap.set(key, new Map());
        detailMeta.set(key, {
          category: v.promptCategory ?? "",
          prompt: v.prompt,
          provider: v.provider,
          model: v.model,
        });
      }
      detailMap.get(key)!.set(date, v);
    }
  }

  // Sort keys by category → prompt → provider
  const sortedDetailKeys = [...detailMap.keys()].sort((a, b) => {
    const ma = detailMeta.get(a)!;
    const mb = detailMeta.get(b)!;
    return (
      ma.category.localeCompare(mb.category) ||
      ma.prompt.localeCompare(mb.prompt) ||
      ma.provider.localeCompare(mb.provider)
    );
  });

  // Header
  const detailHeader = ["Category", "Prompt", "Provider", "Model"];
  for (const date of dates) {
    detailHeader.push(
      `${date} Mentioned`,
      `${date} Accuracy`,
      `${date} Cited`,
      `${date} Rank`,
    );
  }

  const detailRows = [csvRow(detailHeader)];
  for (const key of sortedDetailKeys) {
    const meta = detailMeta.get(key)!;
    const dateMap = detailMap.get(key)!;
    const cells = [meta.category, meta.prompt, meta.provider, meta.model];

    for (const date of dates) {
      const v = dateMap.get(date);
      if (!v) {
        cells.push("", "", "", "");
      } else {
        cells.push(
          v.brandMention.mentioned ? "Yes" : "No",
          v.descriptionAccuracy != null
            ? String(v.descriptionAccuracy.score)
            : "",
          v.ownedCitation.cited ? "Yes" : "No",
          rankDisplay(v.competitivePosition.brandRank),
        );
      }
    }
    detailRows.push(csvRow(cells));
  }

  const detailPath = join(outputDir, "tracker-detail.csv");
  await writeFile(detailPath, `${detailRows.join("\n")}\n`);
  console.log(`Wrote ${detailPath} (${sortedDetailKeys.length} rows)`);

  // --- Summary CSV ---

  // Build map: prompt → Map<date, ResultVerdict[]>
  const summaryMap = new Map<string, Map<string, ResultVerdict[]>>();
  const promptCategory = new Map<string, string>();

  for (const [date, verdicts] of verdictsByDate) {
    for (const v of verdicts) {
      if (!summaryMap.has(v.prompt)) {
        summaryMap.set(v.prompt, new Map());
        promptCategory.set(v.prompt, v.promptCategory ?? "");
      }
      const dateMap = summaryMap.get(v.prompt)!;
      if (!dateMap.has(date)) dateMap.set(date, []);
      dateMap.get(date)!.push(v);
    }
  }

  const sortedPrompts = [...summaryMap.keys()].sort((a, b) => {
    const ca = promptCategory.get(a)!;
    const cb = promptCategory.get(b)!;
    return ca.localeCompare(cb) || a.localeCompare(b);
  });

  const summaryHeader = ["Category", "Prompt"];
  for (const date of dates) {
    summaryHeader.push(
      `${date} Mentions`,
      `${date} Avg Accuracy`,
      `${date} Citations`,
      `${date} Best Rank`,
    );
  }

  const summaryRows = [csvRow(summaryHeader)];
  for (const prompt of sortedPrompts) {
    const category = promptCategory.get(prompt)!;
    const dateMap = summaryMap.get(prompt)!;
    const cells = [category, prompt];

    for (const date of dates) {
      const verdicts = dateMap.get(date);
      if (!verdicts || verdicts.length === 0) {
        cells.push("", "", "", "");
        continue;
      }

      const mentionedCount = verdicts.filter(
        (v) => v.brandMention.mentioned,
      ).length;
      const citedCount = verdicts.filter((v) => v.ownedCitation.cited).length;

      const accuracyScores = verdicts
        .filter((v) => v.descriptionAccuracy != null)
        .map((v) => v.descriptionAccuracy!.score);
      const avgAccuracy =
        accuracyScores.length > 0
          ? (
              accuracyScores.reduce((a, b) => a + b, 0) / accuracyScores.length
            ).toFixed(1)
          : "";

      const numericRanks = verdicts
        .map((v) => v.competitivePosition.brandRank)
        .filter((r): r is 1 | 2 | 3 => r !== "not_ranked");
      const bestRank =
        numericRanks.length > 0 ? String(Math.min(...numericRanks)) : "";

      cells.push(
        String(mentionedCount),
        avgAccuracy,
        String(citedCount),
        bestRank,
      );
    }
    summaryRows.push(csvRow(cells));
  }

  const summaryPath = join(outputDir, "tracker-summary.csv");
  await writeFile(summaryPath, `${summaryRows.join("\n")}\n`);
  console.log(`Wrote ${summaryPath} (${sortedPrompts.length} rows)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
