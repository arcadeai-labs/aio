// Production server entry (Bun runtime).
//
// `vite build` emits two things:
//   - dist/server/server.js — a Web-standard SSR fetch handler
//   - dist/client/**        — the static client bundle (CSS/JS under /assets)
//
// The SSR handler does NOT serve the static client files, so this wrapper serves
// dist/client first and falls through to SSR for everything else. Run with:
//   bun run server.ts            (after `bun run build`)
//
// Not part of the TS project (lives outside src/); it imports the built artifact
// which only exists post-build.
import { join, normalize, sep } from "node:path";
// @ts-expect-error — built artifact, present only after `vite build`.
import handler from "./dist/server/server.js";

const port = Number(process.env.PORT ?? 3000);
const clientDir = join(import.meta.dir, "dist", "client");

async function serveStatic(pathname: string): Promise<Response | null> {
  // Resolve within clientDir and reject any path-traversal attempt.
  const filePath = normalize(join(clientDir, decodeURIComponent(pathname)));
  if (filePath !== clientDir && !filePath.startsWith(clientDir + sep))
    return null;

  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;

  const headers = new Headers();
  // Vite content-hashes everything under /assets, so it's safe to cache forever.
  if (pathname.startsWith("/assets/")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  return new Response(file, { headers });
}

Bun.serve({
  port,
  idleTimeout: 60,
  async fetch(request) {
    if (request.method === "GET" || request.method === "HEAD") {
      const { pathname } = new URL(request.url);
      const asset = await serveStatic(pathname);
      if (asset) return asset;
    }
    // Health checks and real traffic both fall through to SSR here.
    return handler.fetch(request);
  },
});

console.log(`aio web listening on :${port}`);
