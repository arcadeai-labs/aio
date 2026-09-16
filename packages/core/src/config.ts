// Brand / analytics configuration contract. Lives in core because both the
// pipeline (which runs analysis) and the dashboard (which snapshots config per
// run and defines owned-citation / competitor cohorts from it) depend on it.

export interface BrandConfig {
  name: string;
  aliases: string[];
  ownedDomains: string[];
  groundTruthDescription: string;
  knownCompetitors: string[];
}

export interface JudgeModelConfig {
  provider: "openai" | "anthropic";
  model: string;
}

export interface GoogleSheetConfig {
  spreadsheetId?: string;
  detailSheetName?: string; // default: "Detail"
  summarySheetName?: string; // default: "Summary"
  clientSecretFile?: string;
  tokensFile?: string; // default: ".google-tokens.json"
}

export interface AnalyticsConfig {
  brand: BrandConfig;
  judgeModel: JudgeModelConfig;
  concurrency: number;
  resultsDir: string;
  outputDir: string;
  googleSheet?: GoogleSheetConfig;
}
