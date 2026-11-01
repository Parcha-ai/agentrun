/// <reference types="vitest" />
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { devProxy } from "./src/lib/devProxy";

// The console builds to static files with relative URLs, so AgentRun Server can serve them from any path.
// `npm run dev` proxies /v2 as src/lib/devProxy.ts says: to the AgentRun Server AGENTRUN_URL names, else the one on this
// machine at serve's default port, with AGENTRUN_TOKEN.

const v2 = devProxy(process.env)["/v2"];

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    proxy: {
      "/v2": {
        ...v2,
        // Without a token the console signs in like the served page: the server takes a cookie write only from its own
        // origin, so a request from this dev server's own origin is sent as the server's (as the serve dev kit's proxy does).
        configure: (proxy) => proxy.on("proxyReq", (req, incoming) => {
          const host = incoming.headers.host;
          if (host && incoming.headers.origin === `http://${host}`) req.setHeader("origin", new URL(v2.target).origin);
        }),
      },
    },
  },
  resolve: { alias: { "@dsl": fileURLToPath(new URL("../../packages/dsl/src", import.meta.url)), "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { outDir: "dist", assetsInlineLimit: 0 },
  test: { environment: "jsdom", include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
