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
// So this counts what the rows actually are, sorting each into one of four
// buckets. Two of them are tolerated and two are not, and the distinction is
// the whole design:
//
//   usable       no error recorded, and response text with something in it.
//   errored      the provider failed. TOLERATED. A run where some providers
//                errored is a legitimate configuration — Preflight already
//                warns when only part of the key set is present, and failing
//                here would make a deliberate single-provider setup
//                un-runnable. Surfacing these in the run summary is #9's.
//   empty        no error, but no response text either. Not corruption: the
//                pipeline wrote exactly what it got. Nothing for the judge to
//                score, though, so it cannot be the only thing in the file —
//                an empty answer reaches the dashboard as a confident zero.
//   unparseable  the line is not JSON. NOT TOLERATED AT ANY COUNT. This is a
//                different kind of fact from the other three: an errored row
//                is the pipeline faithfully recording a provider failing,
//                whereas an unparseable row means the artefact itself is
//                damaged and no longer a trustworthy record of what the
//                providers said. "Some of it parsed" is not a basis for
//                uploading it as the week's data.
//
// Whitespace does not count as response text. `" \t "` is an empty answer
// wearing a costume, and it must not satisfy the guard. The test is `trim()`
// and nothing more — no minimum length, because a legitimately terse answer
// ("Yes, Taskwell is a to-do app.") is a real result.
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
  empty: number;
  unparseable: number;
}

function tally(file: string, text: string): Tally {
  const t: Tally = {
    file,
    rows: 0,
    usable: 0,
    errored: 0,
    empty: 0,
    unparseable: 0,
  };

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    t.rows++;

    let row: { error?: unknown; responseText?: unknown };
    try {
      row = JSON.parse(line);
    } catch {
      t.unparseable++;
      continue;
    }

    if (row.error != null) {
      t.errored++;
    } else if (
      typeof row.responseText === "string" &&
      row.responseText.trim() !== ""
    ) {
      t.usable++;
    } else {
      t.empty++;
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
    empty: acc.empty + t.empty,
    unparseable: acc.unparseable + t.unparseable,
  }),
  { rows: 0, usable: 0, errored: 0, empty: 0, unparseable: 0 },
);

for (const t of tallies) {
  console.log(
    `${t.file}: ${t.rows} rows, ${t.usable} usable, ${t.errored} errored, ${t.empty} empty, ${t.unparseable} unparseable`,
  );
}

if (total.rows === 0) {
  fail(
    "Results file is empty",
    `bun run start exited 0 but every ${outputDir}/results-*.jsonl it wrote is empty. Uploading this would archive a week of nothing.`,
  );
}

// Checked before the usable count, and independently of it: one damaged line
// discredits the file whether or not the rest of it parsed.
if (total.unparseable > 0) {
  fail(
    "Results file is corrupt",
    `${total.unparseable} of ${total.rows} lines are not valid JSON. Unlike a provider error, which the pipeline records faithfully, this means the artefact itself is damaged — it is no longer a trustworthy record of what the providers said, so the other ${total.rows - total.unparseable} lines are not a basis for uploading it as this week's data.`,
  );
}

if (total.usable === 0) {
  fail(
    "No usable results",
    `All ${total.rows} rows are unusable (${total.errored} carry a provider error, ${total.empty} have no response text). This is what a run with missing or rejected API keys produces: it exits 0, writes a full-size file, and every row in it is a failure. Check the provider keys in this repository's secrets.`,
  );
}

if (total.usable < total.rows) {
  console.log(
    `::warning title=Some results are unusable::${total.usable} of ${total.rows} rows are usable (${total.errored} errored, ${total.empty} without response text). A partial run is legitimate, but those rows are excluded from every analysis denominator.`,
  );
}

console.log(`ok: ${total.usable} of ${total.rows} rows usable`);
