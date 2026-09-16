import { readFile } from "node:fs/promises";

export async function loadCsv(
  filePath: string,
): Promise<Record<string, string>[]> {
  const content = await readFile(filePath, "utf-8");
  return parseCsv(content, detectDelimiter(filePath, content));
}

function detectDelimiter(filePath: string, content: string): string {
  if (filePath.endsWith(".tsv")) return "\t";
  const firstLine = content.split("\n")[0] ?? "";
  if (firstLine.includes("\t") && !firstLine.includes(",")) return "\t";
  return ",";
}

function parseCsv(
  content: string,
  delimiter: string,
): Record<string, string>[] {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseLine(lines[0], delimiter);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i], delimiter);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    rows.push(row);
  }

  return rows;
}

function parseLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }

  fields.push(current.trim());
  return fields;
}
