/// <reference types="vitest" />
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The console builds to static files with relative URLs, so AgentRun Server can serve them from any path.
// `npm run dev` proxies /v2 to a local AgentRun Server (AGENTRUN_URL, default the dev kit's 127.0.0.1:7342) with its token
// (AGENTRUN_TOKEN) as a bearer header. The token stays in the dev server's process: it is never part of the bundle.
const api = process.env.AGENTRUN_URL ?? "http://127.0.0.1:7342";
const token = process.env.AGENTRUN_TOKEN;

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    proxy: { "/v2": { target: api, changeOrigin: true, headers: token ? { authorization: `Bearer ${token}` } : {} } },
  },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", assetsInlineLimit: 0 },
  test: { environment: "jsdom", include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
