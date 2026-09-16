import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UnifiedResult } from "../types/unified-result.js";

export class JsonlStore {
  private filePath: string;

  constructor(outputDir: string, date?: Date) {
    const d = date ?? new Date();
    const dateStr = d.toISOString().slice(0, 10);
    this.filePath = join(outputDir, `results-${dateStr}.jsonl`);
  }

  async append(result: UnifiedResult): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(result)}\n`, "utf-8");
  }

  getFilePath(): string {
    return this.filePath;
  }
}
