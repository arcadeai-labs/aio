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
  /**
   * Marks every run analysed under this config as generated rather than
   * measured (`bun run seed`). The whole config is snapshotted per run into
   * `config_snapshots.raw`, so the flag travels with the data into the database
   * and the dashboard renders a permanent header marker for those runs.
   *
   * Optional, and **absent means real**: every run ingested before this field
   * existed was produced by the real pipeline. Read it with
   * {@link isSyntheticConfig} — never a truthiness check, which would promote a
   * missing key or the string `"false"` into a claim that measured data was
   * invented.
   */
  synthetic?: boolean;
}

/**
 * Whether a persisted config snapshot marks its run as synthetic.
 *
 * Deliberately strict (`=== true`) and total over `unknown`, because both
 * mistakes it guards against are silent. A snapshot is read back out of a
 * `jsonb` column as `unknown`: a missing key, `null`, `"false"`, or a whole
 * missing snapshot must all read as *not synthetic*, or real measurements get
 * labelled invented — which teaches readers to ignore the marker, and so breaks
 * the seeded case too.
 */
export function isSyntheticConfig(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  return (raw as { synthetic?: unknown }).synthetic === true;
}
