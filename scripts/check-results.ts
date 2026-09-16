#!/usr/bin/env bun
//
// Post-run guard for .github/workflows/weekly-run.yml.
//
// `bun run start` exits 0 whether it captured six good answers or six
// authentication failures — the run logs "Run complete" either way. Counting
// lines therefore proves nothing: an all-error file has exactly as many rows as
// a good one, uploads just as cleanly, and reports the same green check. That
// artefact is worse than no artefact, because someone downloads it a month
// later and judges it.
//
// So this counts what the rows actually are. A row is usable when the pipeline
// recorded no error for it AND it carries response text — a `UnifiedResult`
// whose `error` is null but whose `responseText` is empty has nothing for the
// judge to score, and would reach the dashboard as a confident zero.
//
// The bar is "at least one usable row", not "no errors". A run where some
// providers failed is a legitimate configuration — the workflow's Preflight
// step already warns when only part of the key set is present — and failing it
// here would make a deliberate single-provider setup un-runnable. Making those
// partial failures visible in the run summary is issue #9's job, not this
// guard's.
//
// Reads OUTPUT_DIR (the same variable the pipeline writes to), default
// "results". Exits 1 with a GitHub annotation when the artefact is unusable.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

interface Tally {
  file: string;
  rows: number;
  usable: number;
  errored: number;
  unreadable: number;
}

function tally(file: string, text: string): Tally {
  const t: Tally = { file, rows: 0, usable: 0, errored: 0, unreadable: 0 };

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    t.rows++;

    let row: { error?: unknown; responseText?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      t.unreadable++;
      continue;
    }

    if (row.error != null) {
      t.errored++;
    } else if (
      typeof row.responseText === "string" &&
      row.responseText !== ""
    ) {
      t.usable++;
    } else {
      // No error recorded and nothing to read. Counted apart from errored rows
      // so the log says which of the two shapes went wrong.
      t.unreadable++;
    }
  }

  return t;
}

function fail(title: string, message: string): never {
  console.log(`::error title=${title}::${message}`);
  process.exit(1);
}

const outputDir = process.env.OUTPUT_DIR ?? "results";

let entries: string[];
try {
  entries = await readdir(outputDir);
} catch {
  entries = [];
}

const files = entries
  .filter((n) => /^results-.*\.jsonl$/.test(n))
  .sort()
  .map((n) => join(outputDir, n));

if (files.length === 0) {
  fail(
    "No results file",
    `bun run start exited 0 but wrote no ${outputDir}/results-*.jsonl. Nothing was captured, so there is nothing to upload.`,
  );
}

const tallies: Tally[] = [];
for (const file of files) {
  tallies.push(tally(file, await Bun.file(file).text()));
}

const total = tallies.reduce(
  (acc, t) => ({
    rows: acc.rows + t.rows,
    usable: acc.usable + t.usable,
    errored: acc.errored + t.errored,
    unreadable: acc.unreadable + t.unreadable,
  }),
  { rows: 0, usable: 0, errored: 0, unreadable: 0 },
);

for (const t of tallies) {
  console.log(
    `${t.file}: ${t.rows} rows, ${t.usable} usable, ${t.errored} errored, ${t.unreadable} unreadable`,
  );
}

if (total.rows === 0) {
  fail(
    "Results file is empty",
    `bun run start exited 0 but every ${outputDir}/results-*.jsonl it wrote is empty. Uploading this would archive a week of nothing.`,
  );
}

if (total.usable === 0) {
  fail(
    "No usable results",
    `All ${total.rows} rows are unusable (${total.errored} carry a provider error, ${total.unreadable} have no response text). This is what a run with missing or rejected API keys produces: it exits 0, writes a full-size file, and every row in it is a failure. Check the provider keys in this repository's secrets.`,
  );
}

if (total.usable < total.rows) {
  console.log(
    `::warning title=Some results are unusable::${total.usable} of ${total.rows} rows are usable (${total.errored} errored, ${total.unreadable} without response text). A partial run is legitimate, but those rows are excluded from every analysis denominator.`,
  );
}

console.log(`ok: ${total.usable} of ${total.rows} rows usable`);
