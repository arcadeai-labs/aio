// @aio/db — Drizzle schema + typed query/metrics layer.
// Source of truth for the Postgres schema, imported by both `web` (reads) and,
// from issue #4, `ingest` (writes).
//
// Issue #3 establishes the connection and the better-auth tables; the analytics
// schema + metrics layer land in issue #4.

export { db, schema, type Schema } from "./client.js";
export * from "./schema/index.js";
export {
  findUserAccessFields,
  type UserAccessFields,
} from "./auth-queries.js";
export * from "./metrics.js";
export * from "./queries.js";
