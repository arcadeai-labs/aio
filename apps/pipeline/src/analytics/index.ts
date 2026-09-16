import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { logger } from "../util/logger.js";
import { type AnalyzeOptions, analyzeResults } from "./analyzer.js";
import { compareWeeks } from "./comparator.js";
import { loadAnalyticsConfig } from "./config.js";
import {
  findPreviousAnalysisDate,
  loadResults,
  loadVerdicts,
} from "./loader.js";
import { generateReport } from "./reporter.js";
import type { WeekComparison } from "./types.js";

function parseOptions(argv: string[]): AnalyzeOptions {
  const resume =
    argv.includes("--resume") || process.env.ANALYSIS_RESUME === "1";

  const rejudgeFlag = argv.find((a) => a.startsWith("--rejudge-before="));
  const rejudgeBefore =
    rejudgeFlag?.slice("--rejudge-before=".length) ??
    process.env.ANALYSIS_REJUDGE_BEFORE;

  if (rejudgeBefore && !resume) {
    throw new Error("--rejudge-before only applies together with --resume");
  }
  if (rejudgeBefore && Number.isNaN(Date.parse(rejudgeBefore))) {
    throw new Error(
      `--rejudge-before is not a valid timestamp: ${rejudgeBefore}`,
    );
  }

  return { resume, rejudgeBefore };
}

async function main(): Promise<void> {
  const date =
    process.env.ANALYSIS_DATE ?? new Date().toISOString().slice(0, 10);

  const options = parseOptions(process.argv.slice(2));
  const config = await loadAnalyticsConfig();
  const resultsDir = resolve(config.resultsDir);
  const outputDir = resolve(config.outputDir);

  logger.info({ date, resultsDir, outputDir, ...options }, "Starting analysis");

  // Phase 1: Judge each result
  const results = await loadResults(resultsDir, date);
  logger.info({ count: results.length }, "Loaded results");

  const verdicts = await analyzeResults(results, config, date, options);

  // Phase 2: Compare with previous week (if available)
  let comparison: WeekComparison | null = null;
  const prevDate = await findPreviousAnalysisDate(outputDir, date);

  if (prevDate) {
    logger.info({ previousDate: prevDate }, "Found previous analysis");
    const prevVerdicts = await loadVerdicts(outputDir, prevDate);
    comparison = compareWeeks(verdicts, prevVerdicts, date, prevDate);

    const comparisonPath = join(outputDir, `comparison-${date}.json`);
    await writeFile(
      comparisonPath,
      JSON.stringify(comparison, null, 2),
      "utf-8",
    );
    logger.info({ comparisonPath }, "Comparison written");
  } else {
    logger.info("No previous analysis found — skipping comparison");
  }

  // Generate Markdown report
  const report = generateReport(verdicts, date, comparison, config.brand.name);
  const reportPath = join(outputDir, `summary-${date}.md`);
  await writeFile(reportPath, report, "utf-8");
  logger.info({ reportPath }, "Summary report written");

  logger.info("Analysis pipeline complete");
}

main().catch((err) => {
  logger.fatal(err, "Fatal error in analytics");
  process.exit(1);
});
