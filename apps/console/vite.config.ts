/// <reference types="vitest" />
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { devProxy } from "./src/lib/devProxy";

// The console builds to static files with relative URLs, so AgentRun Server can serve them from any path.
// `npm run dev` proxies /v2 as src/lib/devProxy.ts says: to the AgentRun Server AGENTRUN_URL names, else the one on this
// machine at serve's default port, with AGENTRUN_TOKEN.

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    proxy: devProxy(process.env),
  },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", assetsInlineLimit: 0 },
  test: { environment: "jsdom", include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
