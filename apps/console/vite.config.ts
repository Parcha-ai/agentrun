/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { devProxy } from "./src/lib/devProxy";
import { thirdPartyNotices } from "./third-party-notices.mjs";

// The console builds to static files with relative URLs, so AgentRun Server can serve them from any path.
// `npm run dev` proxies /v2 as src/lib/devProxy.ts says: to the AgentRun Server AGENTRUN_URL names, else the one on this
// machine at serve's default port, with AGENTRUN_TOKEN.

const v2 = devProxy(process.env)["/v2"];
// A cap on the test workers from VITEST_MAX_WORKERS, for a machine shared with other work. Vitest reads the variable too,
// but with parseInt, which takes "4x" as 4 and drops "x" without a word. Unset or empty keeps vitest's own default of a
// worker per core. Anything but a whole number is refused, as pi-browser's TEST_CONCURRENCY is: a cap that was asked for
// and silently dropped would start every worker.
const wanted = process.env.VITEST_MAX_WORKERS?.trim() ?? "";
if (wanted !== "" && !/^[1-9][0-9]*$/.test(wanted)) throw new Error(`VITEST_MAX_WORKERS must be a whole number of workers, got "${wanted}"`);
const workers = wanted === "" ? undefined : Number(wanted);
const alias = {
  "@dsl": fileURLToPath(new URL("../../packages/dsl/src", import.meta.url)),
  // The timeline library's tool names and pi-browser's tool list, from their sources (each imports nothing of Node).
  "@timeline": fileURLToPath(new URL("../../packages/pi-durable-agent/src/timeline", import.meta.url)),
  "@pi-browser": fileURLToPath(new URL("../../packages/pi-browser/src/core", import.meta.url)),
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};
// Story tests run from this file through @storybook/addon-vitest: with VITEST_STORYBOOK=true (`npm run test-storybook`, or
// Storybook's own process) the only project is .storybook/vitest.project.ts's. Every other run, `npm test` among them,
// keeps the unit configuration below and no projects.
const projects = process.env.VITEST_STORYBOOK === "true" ? [(await import("./.storybook/vitest.project")).storybookProject(alias)] : undefined;

export default defineConfig({
  base: "./",
  // THIRD-PARTY-NOTICES.txt beside index.html: the licenses of what the bundle holds (third-party-notices.mjs).
  plugins: [react(), thirdPartyNotices()],
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
  resolve: { alias },
  build: { outDir: "dist", assetsInlineLimit: 0 },
  // css: tokens.css is read as text (`?raw`) by the design-system test and stories; every other stylesheet stays a stub.
  test: { environment: "jsdom", include: ["src/**/*.test.ts", "src/**/*.test.tsx"], css: { include: [/\.css\?raw$/] }, ...(workers ? { maxWorkers: workers } : {}), ...(projects ? { projects } : {}) },
});
