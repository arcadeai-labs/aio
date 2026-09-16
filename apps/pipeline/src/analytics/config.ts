import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AnalyticsConfig } from "./types.js";

const DEFAULTS: Omit<AnalyticsConfig, "brand"> = {
  judgeModel: { provider: "openai", model: "gpt-5.4-mini" },
  concurrency: 5,
  resultsDir: "results",
  outputDir: "results/analysis",
};

export async function loadAnalyticsConfig(
  path?: string,
): Promise<AnalyticsConfig> {
  const configPath = resolve(
    path ?? process.env.ANALYTICS_CONFIG ?? "analytics.config.json",
  );

  const raw = await readFile(configPath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<AnalyticsConfig>;

  if (!parsed.brand?.name) {
    throw new Error(
      `analytics config at ${configPath} must include brand.name`,
    );
  }

  return {
    brand: {
      name: parsed.brand.name,
      aliases: parsed.brand.aliases ?? [],
      ownedDomains: parsed.brand.ownedDomains ?? [],
      groundTruthDescription: parsed.brand.groundTruthDescription ?? "",
      knownCompetitors: parsed.brand.knownCompetitors ?? [],
    },
    judgeModel: parsed.judgeModel ?? DEFAULTS.judgeModel,
    concurrency: parsed.concurrency ?? DEFAULTS.concurrency,
    resultsDir: parsed.resultsDir ?? DEFAULTS.resultsDir,
    outputDir: parsed.outputDir ?? DEFAULTS.outputDir,
    googleSheet: parsed.googleSheet,
    // Carried through rather than defaulted: absent stays absent, so a config
    // that says nothing about provenance never claims its runs are synthetic.
    synthetic: parsed.synthetic,
  };
}

export async function saveGoogleSheetId(
  configPath: string | undefined,
  spreadsheetId: string,
): Promise<void> {
  const resolvedPath = resolve(
    configPath ?? process.env.ANALYTICS_CONFIG ?? "analytics.config.json",
  );
  const raw = await readFile(resolvedPath, "utf-8");
  const config = JSON.parse(raw);
  config.googleSheet = { ...config.googleSheet, spreadsheetId };
  await writeFile(resolvedPath, `${JSON.stringify(config, null, 2)}\n`);
}
