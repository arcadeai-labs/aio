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
import { isAccessRestricted, parseAllowedDomains } from "@aio/core";
import { resolveAuthSecret } from "./src/lib/auth-secret";

// Resolve the session signing secret HERE, at boot, before the SSR bundle is
// even loaded — and then hand the result to the bundle through the environment.
//
// The bundle would resolve it on its own, but only on the first render, because
// that is when its auth module is first imported. That is precisely the shape
// of #20: a container that logs "listening", reports RestartCount=0, answers
// one redirect, and then dies mid-request — a config error wearing the costume
// of a flaky container. Doing it up here turns every remaining failure in that
// resolution (a deployment with ALLOWED_EMAIL_DOMAINS set and no secret) into a
// boot crash with a named variable in it, which is a thing a human can read.
//
// Writing the value back into `process.env` rather than passing it in keeps one
// secret and one warning: the bundle's own call then sees a supplied value and
// returns it untouched, instead of generating a second, different one.
process.env.BETTER_AUTH_SECRET = resolveAuthSecret({
  supplied: process.env.BETTER_AUTH_SECRET,
  accessRestricted: isAccessRestricted(
    parseAllowedDomains(process.env.ALLOWED_EMAIL_DOMAINS),
  ),
});

// Dynamically imported so it lands *after* the resolution above. A static
// import would be hoisted above it, and the ordering is the whole point.
// @ts-expect-error — built artifact, present only after `vite build`.
const { default: handler } = await import("./dist/server/server.js");

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
