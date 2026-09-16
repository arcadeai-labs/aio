import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig } from "drizzle-kit";

// drizzle-kit does not auto-load .env. Walk up from the current directory to the
// nearest .env and load any vars not already set, so `drizzle-kit migrate` works
// whether invoked from the repo root or from packages/db. An explicitly-passed
// env var (e.g. `DATABASE_URL=... drizzle-kit migrate`) always wins.
function loadNearestDotenv(): void {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    const file = join(dir, ".env");
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
        if (!match) continue;
        const [, key, rawValue] = match;
        if (process.env[key] !== undefined) continue;
        let value = rawValue;
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[key] = value;
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

loadNearestDotenv();

// Migrations are generated into ./drizzle and applied with `drizzle-kit migrate`
// (run locally against Render's external URL, and on deploy — see render.yaml).
export default defineConfig({
  // Point at the concrete schema files (not the `.js`-re-exporting barrel, which
  // drizzle-kit's CJS loader can't follow).
  schema: ["./src/schema/auth.ts", "./src/schema/analytics.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  // Keep generated SQL readable in review.
  verbose: true,
  strict: true,
});
