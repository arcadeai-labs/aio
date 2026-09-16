import { loadAnalyticsConfig, saveGoogleSheetId } from "./config.js";
import { loadVerdicts } from "./loader.js";
import { SheetsClient } from "./sheets-client.js";
import {
  findAllAnalysisDates,
  makeDetailKey,
  rankDisplay,
} from "./spreadsheet.js";
import type { ResultVerdict } from "./types.js";

function colLetter(index: number): string {
  let s = "";
  let n = index;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

type DetailKey = string;

interface DetailMeta {
  category: string;
  prompt: string;
  provider: string;
  model: string;
}

function buildDetailData(
  dates: string[],
  verdictsByDate: Map<string, ResultVerdict[]>,
): { header: string[]; rows: (string | number)[][]; sortedKeys: DetailKey[] } {
  const detailMap = new Map<DetailKey, Map<string, ResultVerdict>>();
  const detailMeta = new Map<DetailKey, DetailMeta>();

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

  const sortedKeys = [...detailMap.keys()].sort((a, b) => {
    const ma = detailMeta.get(a)!;
    const mb = detailMeta.get(b)!;
    return (
      ma.category.localeCompare(mb.category) ||
      ma.prompt.localeCompare(mb.prompt) ||
      ma.provider.localeCompare(mb.provider)
    );
  });

  const header: string[] = ["Category", "Prompt", "Provider", "Model"];
  for (const date of dates) {
    header.push(
      `${date} Mentioned`,
      `${date} Accuracy`,
      `${date} Cited`,
      `${date} Rank`,
    );
  }

  const rows: (string | number)[][] = [];
  for (const key of sortedKeys) {
    const meta = detailMeta.get(key)!;
    const dateMap = detailMap.get(key)!;
    const cells: (string | number)[] = [
      meta.category,
      meta.prompt,
      meta.provider,
      meta.model,
    ];

    for (const date of dates) {
      const v = dateMap.get(date);
      if (!v) {
        cells.push("", "", "", "");
      } else {
        cells.push(
          v.brandMention.mentioned ? "Yes" : "No",
          v.descriptionAccuracy != null ? v.descriptionAccuracy.score : "",
          v.ownedCitation.cited ? "Yes" : "No",
          rankDisplay(v.competitivePosition.brandRank),
        );
      }
    }
    rows.push(cells);
  }

  return { header, rows, sortedKeys };
}

function buildSummaryData(
  dates: string[],
  verdictsByDate: Map<string, ResultVerdict[]>,
): { header: string[]; rows: (string | number)[][]; sortedKeys: string[] } {
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

  const sortedKeys = [...summaryMap.keys()].sort((a, b) => {
    const ca = promptCategory.get(a)!;
    const cb = promptCategory.get(b)!;
    return ca.localeCompare(cb) || a.localeCompare(b);
  });

  const header: string[] = ["Category", "Prompt"];
  for (const date of dates) {
    header.push(
      `${date} Mentions`,
      `${date} Avg Accuracy`,
      `${date} Citations`,
      `${date} Best Rank`,
    );
  }

  const rows: (string | number)[][] = [];
  for (const prompt of sortedKeys) {
    const category = promptCategory.get(prompt)!;
    const dateMap = summaryMap.get(prompt)!;
    const cells: (string | number)[] = [category, prompt];

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
          ? +(
              accuracyScores.reduce((a, b) => a + b, 0) / accuracyScores.length
            ).toFixed(1)
          : "";

      const numericRanks = verdicts
        .map((v) => v.competitivePosition.brandRank)
        .filter((r): r is 1 | 2 | 3 => r !== "not_ranked");
      const bestRank = numericRanks.length > 0 ? Math.min(...numericRanks) : "";

      cells.push(mentionedCount, avgAccuracy, citedCount, bestRank);
    }
    rows.push(cells);
  }

  return { header, rows, sortedKeys };
}

function buildDetailColumnsForDates(
  dates: string[],
  verdictsByDate: Map<string, ResultVerdict[]>,
  existingKeyToRow: Map<string, number>,
  totalRows: number,
): { header: (string | number)[]; dataRows: (string | number)[][] } {
  // Build a lookup: key → date → verdict
  const keyDateMap = new Map<DetailKey, Map<string, ResultVerdict>>();
  for (const date of dates) {
    const verdicts = verdictsByDate.get(date) ?? [];
    for (const v of verdicts) {
      const key = makeDetailKey(v);
      if (!keyDateMap.has(key)) keyDateMap.set(key, new Map());
      keyDateMap.get(key)!.set(date, v);
    }
  }

  const header: (string | number)[] = [];
  for (const date of dates) {
    header.push(
      `${date} Mentioned`,
      `${date} Accuracy`,
      `${date} Cited`,
      `${date} Rank`,
    );
  }

  // Initialize empty rows (totalRows - 1 data rows, since row 1 is header)
  const dataRows: (string | number)[][] = [];
  for (let i = 0; i < totalRows - 1; i++) {
    dataRows.push(new Array(dates.length * 4).fill(""));
  }

  for (const [key, dateMap] of keyDateMap) {
    const rowNum = existingKeyToRow.get(key);
    if (rowNum == null) continue; // new key — skip for now
    const rowIdx = rowNum - 2; // rowNum is 1-based, header is row 1
    for (let di = 0; di < dates.length; di++) {
      const v = dateMap.get(dates[di]);
      if (!v) continue;
      const colOff = di * 4;
      dataRows[rowIdx][colOff] = v.brandMention.mentioned ? "Yes" : "No";
      dataRows[rowIdx][colOff + 1] =
        v.descriptionAccuracy != null ? v.descriptionAccuracy.score : "";
      dataRows[rowIdx][colOff + 2] = v.ownedCitation.cited ? "Yes" : "No";
      dataRows[rowIdx][colOff + 3] = rankDisplay(
        v.competitivePosition.brandRank,
      );
    }
  }

  return { header, dataRows };
}

function buildSummaryColumnsForDates(
  dates: string[],
  verdictsByDate: Map<string, ResultVerdict[]>,
  existingKeyToRow: Map<string, number>,
  totalRows: number,
): { header: (string | number)[]; dataRows: (string | number)[][] } {
  // Build lookup: prompt → date → verdicts[]
  const promptDateMap = new Map<string, Map<string, ResultVerdict[]>>();
  for (const date of dates) {
    const verdicts = verdictsByDate.get(date) ?? [];
    for (const v of verdicts) {
      if (!promptDateMap.has(v.prompt)) promptDateMap.set(v.prompt, new Map());
      const dm = promptDateMap.get(v.prompt)!;
      if (!dm.has(date)) dm.set(date, []);
      dm.get(date)!.push(v);
    }
  }

  const header: (string | number)[] = [];
  for (const date of dates) {
    header.push(
      `${date} Mentions`,
      `${date} Avg Accuracy`,
      `${date} Citations`,
      `${date} Best Rank`,
    );
  }

  const dataRows: (string | number)[][] = [];
  for (let i = 0; i < totalRows - 1; i++) {
    dataRows.push(new Array(dates.length * 4).fill(""));
  }

  for (const [prompt, dateMap] of promptDateMap) {
    // Summary key uses category\0prompt — we need to find the matching key
    // But we only have prompt → row mapping with "category\0prompt" keys
    // We need to iterate existing keys to find the one ending with this prompt
    let rowNum: number | undefined;
    for (const [key, rn] of existingKeyToRow) {
      const parts = key.split("\0");
      if (parts[1] === prompt) {
        rowNum = rn;
        break;
      }
    }
    if (rowNum == null) continue;
    const rowIdx = rowNum - 2;

    for (let di = 0; di < dates.length; di++) {
      const verdicts = dateMap.get(dates[di]);
      if (!verdicts || verdicts.length === 0) continue;
      const colOff = di * 4;

      const mentionedCount = verdicts.filter(
        (v) => v.brandMention.mentioned,
      ).length;
      const citedCount = verdicts.filter((v) => v.ownedCitation.cited).length;

      const accuracyScores = verdicts
        .filter((v) => v.descriptionAccuracy != null)
        .map((v) => v.descriptionAccuracy!.score);
      const avgAccuracy =
        accuracyScores.length > 0
          ? +(
              accuracyScores.reduce((a, b) => a + b, 0) / accuracyScores.length
            ).toFixed(1)
          : "";

      const numericRanks = verdicts
        .map((v) => v.competitivePosition.brandRank)
        .filter((r): r is 1 | 2 | 3 => r !== "not_ranked");
      const bestRank = numericRanks.length > 0 ? Math.min(...numericRanks) : "";

      dataRows[rowIdx][colOff] = mentionedCount;
      dataRows[rowIdx][colOff + 1] = avgAccuracy;
      dataRows[rowIdx][colOff + 2] = citedCount;
      dataRows[rowIdx][colOff + 3] = bestRank;
    }
  }

  return { header, dataRows };
}

async function main() {
  const config = await loadAnalyticsConfig();
  const { outputDir } = config;

  // Resolve OAuth client secret
  const clientSecretFile =
    config.googleSheet?.clientSecretFile ??
    process.env.GOOGLE_CLIENT_SECRET_FILE;
  if (!clientSecretFile) {
    console.error(
      "No Google client secret configured.\n" +
        "Set googleSheet.clientSecretFile in analytics.config.json\n" +
        "or set the GOOGLE_CLIENT_SECRET_FILE environment variable.\n\n" +
        "To set up:\n" +
        "1. Create a Google Cloud project and enable the Google Sheets API\n" +
        "2. Create an OAuth2 Client ID (Desktop app type)\n" +
        "3. Download the client secret JSON file",
    );
    process.exit(1);
  }

  const tokensFile = config.googleSheet?.tokensFile ?? ".google-tokens.json";
  const detailSheetName = config.googleSheet?.detailSheetName ?? "Detail";
  const summarySheetName = config.googleSheet?.summarySheetName ?? "Summary";
  const spreadsheetId = config.googleSheet?.spreadsheetId;

  // Create Sheets client (handles OAuth flow)
  const client = await SheetsClient.create({ clientSecretFile, tokensFile });

  // Find local analysis dates
  const localDates = await findAllAnalysisDates(outputDir);
  if (localDates.length === 0) {
    console.log("No analysis files found.");
    return;
  }
  console.log(
    `Found ${localDates.length} local analysis date(s): ${localDates.join(", ")}`,
  );

  if (!spreadsheetId) {
    // --- CREATE MODE ---
    console.log("No spreadsheetId configured — creating new spreadsheet...");

    // Load all verdicts
    const verdictsByDate = new Map<string, ResultVerdict[]>();
    for (const date of localDates) {
      verdictsByDate.set(date, await loadVerdicts(outputDir, date));
    }

    const detail = buildDetailData(localDates, verdictsByDate);
    const summary = buildSummaryData(localDates, verdictsByDate);

    // Create spreadsheet
    const title = `${config.brand.name} AIO Tracker`;
    const newId = await client.createSpreadsheet(title, [
      detailSheetName,
      summarySheetName,
    ]);

    // Write detail data
    const detailValues = [detail.header, ...detail.rows];
    const detailEndCol = colLetter(detail.header.length - 1);
    await client.writeRange(
      newId,
      `${detailSheetName}!A1:${detailEndCol}${detailValues.length}`,
      detailValues,
    );

    // Write summary data
    const summaryValues = [summary.header, ...summary.rows];
    const summaryEndCol = colLetter(summary.header.length - 1);
    await client.writeRange(
      newId,
      `${summarySheetName}!A1:${summaryEndCol}${summaryValues.length}`,
      summaryValues,
    );

    // Save spreadsheetId to config
    try {
      await saveGoogleSheetId(undefined, newId);
      console.log("Saved spreadsheetId to analytics.config.json");
    } catch (err) {
      console.error(
        `Failed to save config. Add this manually:\n  "googleSheet": { "spreadsheetId": "${newId}" }`,
      );
    }

    console.log(
      `\nSpreadsheet created: https://docs.google.com/spreadsheets/d/${newId}`,
    );
  } else {
    // --- UPDATE MODE ---
    console.log(`Updating spreadsheet ${spreadsheetId}...`);

    // Read existing detail headers to find which dates are already present
    const headerRows = await client.readRange(
      spreadsheetId,
      `${detailSheetName}!1:1`,
    );
    const existingHeaders = headerRows[0] ?? [];

    const dateRegex = /^(\d{4}-\d{2}-\d{2})\s/;
    const existingDates = new Set<string>();
    for (const h of existingHeaders) {
      const m = dateRegex.exec(h);
      if (m) existingDates.add(m[1]);
    }

    const newDates = localDates.filter((d) => !existingDates.has(d)).sort();

    if (newDates.length === 0) {
      console.log("Already up to date — no new dates to add.");
      return;
    }

    console.log(`New dates to add: ${newDates.join(", ")}`);

    // Load verdicts only for new dates
    const verdictsByDate = new Map<string, ResultVerdict[]>();
    for (const date of newDates) {
      verdictsByDate.set(date, await loadVerdicts(outputDir, date));
    }

    // Read existing row keys for Detail
    const detailKeyCols = await client.readRange(
      spreadsheetId,
      `${detailSheetName}!A:D`,
    );
    const detailKeyToRow = new Map<string, number>();
    for (let i = 1; i < detailKeyCols.length; i++) {
      const row = detailKeyCols[i];
      if (!row || row.length < 4) continue;
      // cols: Category, Prompt, Provider, Model
      const key = `${row[1]}\0${row[2]}\0${row[3]}`;
      detailKeyToRow.set(key, i + 1); // 1-based row number
    }

    // Read existing row keys for Summary
    const summaryKeyCols = await client.readRange(
      spreadsheetId,
      `${summarySheetName}!A:B`,
    );
    const summaryKeyToRow = new Map<string, number>();
    for (let i = 1; i < summaryKeyCols.length; i++) {
      const row = summaryKeyCols[i];
      if (!row || row.length < 2) continue;
      const key = `${row[0]}\0${row[1]}`;
      summaryKeyToRow.set(key, i + 1);
    }

    // Build new columns for Detail
    const detailTotalRows = detailKeyCols.length;
    const detailCols = buildDetailColumnsForDates(
      newDates,
      verdictsByDate,
      detailKeyToRow,
      detailTotalRows,
    );

    const detailStartColIdx = 4 + existingDates.size * 4;
    const detailEndColIdx = detailStartColIdx + newDates.length * 4 - 1;
    const detailStartCol = colLetter(detailStartColIdx);
    const detailEndCol = colLetter(detailEndColIdx);

    const detailWriteValues = [detailCols.header, ...detailCols.dataRows];
    await client.writeRange(
      spreadsheetId,
      `${detailSheetName}!${detailStartCol}1:${detailEndCol}${detailTotalRows}`,
      detailWriteValues,
    );

    // Build new columns for Summary
    const summaryTotalRows = summaryKeyCols.length;
    const summaryCols = buildSummaryColumnsForDates(
      newDates,
      verdictsByDate,
      summaryKeyToRow,
      summaryTotalRows,
    );

    const summaryStartColIdx = 2 + existingDates.size * 4;
    const summaryEndColIdx = summaryStartColIdx + newDates.length * 4 - 1;
    const summaryStartCol = colLetter(summaryStartColIdx);
    const summaryEndCol = colLetter(summaryEndColIdx);

    const summaryWriteValues = [summaryCols.header, ...summaryCols.dataRows];
    await client.writeRange(
      spreadsheetId,
      `${summarySheetName}!${summaryStartCol}1:${summaryEndCol}${summaryTotalRows}`,
      summaryWriteValues,
    );

    console.log(`${newDates.length} date(s) added: ${newDates.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
