import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Load the monorepo-root .env into process.env for the dev/build process.
  // Bun's `--filter @aio/web dev` runs with cwd=apps/web, so it would otherwise
  // only see apps/web/.env (which doesn't exist) and the server modules
  // (@aio/db, better-auth) would boot without DATABASE_URL / auth secrets.
  // Real process env always wins (e.g. Render's injected vars in production);
  // we only fill in what's missing. "" loads all keys, not just VITE_-prefixed.
  const fileEnv = loadEnv(mode, "../..", "");
  for (const [key, value] of Object.entries(fileEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return {
    plugins: [
      // tanstackStart() must come before viteReact().
      tanstackStart(),
      viteReact(),
    ],
  };
});
