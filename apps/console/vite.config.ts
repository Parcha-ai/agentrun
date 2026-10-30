/// <reference types="vitest" />
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The console builds to static files with relative URLs, so AgentRun Server can serve them from any path.
// `npm run dev` proxies /v2 to the AgentRun Server named by AGENTRUN_URL (its origin, e.g. the dev kit's), with its token
// (AGENTRUN_TOKEN) as a bearer header. With no AGENTRUN_URL there is no proxy. The token stays in the dev server's
// process: it is never part of the bundle.
const api = process.env.AGENTRUN_URL;
const token = process.env.AGENTRUN_TOKEN;

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    proxy: api ? { "/v2": { target: api, changeOrigin: true, headers: token ? { authorization: `Bearer ${token}` } : {} } } : undefined,
  },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", assetsInlineLimit: 0 },
  test: { environment: "jsdom", include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
