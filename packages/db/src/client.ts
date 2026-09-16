// Drizzle Postgres client — the single connection shared by the web app (reads)
// and, from issue #4, the ingest reconciler (writes).
//
// The connection string comes from `DATABASE_URL` (Render managed Postgres in
// production; a local Docker Postgres in development). SSL is enabled whenever
// the URL is not an obvious localhost target, matching Render's external URL.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type Schema = typeof schema;

function resolveConnectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at the Render managed Postgres URL " +
        "(production) or a local Postgres instance (development).",
    );
  }
  return url;
}

function needsSsl(connectionString: string): boolean {
  if (process.env.DATABASE_SSL === "disable") return false;
  return !/@(localhost|127\.0\.0\.1|::1)\b/.test(connectionString);
}

const connectionString = resolveConnectionString();

// `postgres-js` is the driver better-auth's Drizzle adapter and drizzle-kit both
// support cleanly under Bun. A single pooled instance is reused process-wide.
const queryClient = postgres(connectionString, {
  ssl: needsSsl(connectionString) ? "require" : false,
  // Render's connection limits are modest; keep the pool small for the laptop
  // CLI and the single web service.
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
});

export const db = drizzle(queryClient, { schema });

export { schema };
