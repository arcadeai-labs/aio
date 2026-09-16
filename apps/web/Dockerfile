# Production image for the aio dashboard (Bun runtime). The build context is the
# repo ROOT, not this directory, so the whole Bun workspace is available — see
# docker-compose.yml (`context: .`). Building from apps/web will fail.
#
# The same image runs two things: the `migrate` one-shot (from /app) and the web
# server (from /app/apps/web). Keeping them on one image means migrations can
# never be applied by a different version of the code than the one serving.
FROM oven/bun:1.3 AS build
WORKDIR /app

# Install workspace dependencies against the committed lockfile first (cached
# unless manifests change).
COPY package.json bun.lock biome.json tsconfig.base.json tsconfig.json ./
COPY apps/pipeline/package.json ./apps/pipeline/
COPY apps/web/package.json ./apps/web/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/ingest/package.json ./packages/ingest/
RUN bun install --frozen-lockfile

# Copy sources and build the web app. DATABASE_URL is only needed so the
# module-scope DB client constructs during the SSR build; postgres-js connects
# lazily, so this placeholder never opens a connection.
COPY . .
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
RUN bun run --filter @aio/web build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM oven/bun:1.3 AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app

# server.ts binds $PORT, defaulting to 3000 when unset.
ENV PORT=3000
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["bun", "run", "server.ts"]
