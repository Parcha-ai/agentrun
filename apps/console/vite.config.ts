/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { devProxy, ownRequest } from "./src/lib/devProxy";
import { credentialGate } from "./credential-gate.mjs";
import { thirdPartyNotices } from "./third-party-notices.mjs";

// The console builds to static files with relative URLs, so AgentRun Server can serve them from any path.
// `npm run dev` proxies /v2 and the public setup skill as src/lib/devProxy.ts says: to the AgentRun Server
// AGENTRUN_BASE_URL names, else the one on this machine at serve's default port, with a key on the page's own API
// requests alone (AGENTRUN_API_KEY for a named server, else AGENTRUN_TOKEN for a server on this machine).

type Said = { kind: "info" | "warn"; words: string };
/** What the dev proxy had to say when it was set up (where it proxies and with which variable's key, or a token it did
 *  not send), said once the dev or preview server is there to say it. */
const devProxyNotes = (notes: readonly Said[]): Plugin => {
  const say = (logger: { info(words: string): void; warn(words: string): void }) => { for (const { kind, words } of notes) logger[kind](words); };
  return {
    name: "agentrun-dev-proxy-notes",
    apply: "serve",
    configureServer(server) { say(server.config.logger); },
    configurePreviewServer(server) { say(server.config.logger); },
  };
};
// A cap on the test workers from VITEST_MAX_WORKERS, for a machine shared with other work. Vitest reads the variable too,
// but with parseInt, which takes "4x" as 4 and drops "x" without a word. Unset or empty keeps vitest's own default of a
// worker per core. Anything but a whole number is refused, as pi-browser's TEST_CONCURRENCY is: a cap that was asked for
// and silently dropped would start every worker.
const wanted = process.env.VITEST_MAX_WORKERS?.trim() ?? "";
if (wanted !== "" && !/^[1-9][0-9]*$/.test(wanted)) throw new Error(`VITEST_MAX_WORKERS must be a whole number of workers, got "${wanted}"`);
const workers = wanted === "" ? undefined : Number(wanted);
const alias = {
  "@dsl": fileURLToPath(new URL("../../packages/dsl/src", import.meta.url)),
  // The timeline library's tool names, pi-browser's tool list and serve's tool-name grammar, from their sources (each
  // imports nothing of Node; tool-names.ts imports nothing at all, as serve's test/tool-names.test.mjs holds it). The
  // timeline reads URLs in text through web's text-urls.ts, which imports nothing either.
  "@timeline": fileURLToPath(new URL("../../packages/serve/src/timeline", import.meta.url)),
  "@parcha/agentrun-web/text-urls": fileURLToPath(new URL("../../packages/web/src/text-urls.ts", import.meta.url)),
  "@pi-browser": fileURLToPath(new URL("../../packages/pi-browser/src/core", import.meta.url)),
  "@agentrun/tool-names": fileURLToPath(new URL("../../packages/serve/src/tool-names.ts", import.meta.url)),
  "@":fileURLToPath(new URL("./src", import.meta.url)),
};
// Story tests run from this file through @storybook/addon-vitest: with VITEST_STORYBOOK=true (`npm run test-storybook`, or
// Storybook's own process) the only project is .storybook/vitest.project.ts's. Every other run, `npm test` among them,
// keeps the unit configuration below and no projects.
const projects = process.env.VITEST_STORYBOOK === "true" ? [(await import("./.storybook/vitest.project")).storybookProject(alias)] : undefined;

export default defineConfig(({ command, mode }) => {
  // The proxy and its variables are a server's alone: `npm run dev`, a preview, Storybook's dev server, and the one the
  // proxy's own test starts. A build and Vitest's own load of this file (mode "test") read none of them, so a variable
  // left in a shell stops neither; a server refuses one it cannot use (devProxy), by name.
  const notes: Said[] = [];
  const proxy = command === "serve" && mode !== "test" ? devProxy(process.env, (kind, words) => notes.push({ kind, words })) : undefined;
  const v2 = proxy?.["/v2"];
  return {
    base: "./",
    // THIRD-PARTY-NOTICES.txt beside index.html: the licenses of what the bundle holds (third-party-notices.mjs). Then the
    // credential gate (credential-gate.mjs), last: the build fails when the bundle, the notices included, holds a credential.
    plugins: [react(), devProxyNotes(notes), thirdPartyNotices(), credentialGate()],
    server: proxy && v2 ? {
      proxy: {
        ...proxy,
        "/v2": {
          ...v2,
          // The key rides only on the page's own requests and a command line's (ownRequest): another site's page, which
          // reaches this port as the console does, goes on without it. Without a key the console signs in like the served
          // page: the server takes a cookie write only from its own origin, so a request from this dev server's own
          // origin is sent as the server's (as the serve dev kit's proxy does).
          configure: (proxy) => proxy.on("proxyReq", (req, incoming) => {
            const host = incoming.headers.host;
            if (!ownRequest(incoming.headers)) req.removeHeader("authorization");
            if (host && incoming.headers.origin === `http://${host}`) req.setHeader("origin", new URL(v2.target).origin);
          }),
        },
      },
    } : {},
    resolve: { alias },
    // The server serves scripts, styles and fonts; its CSP also permits data images. Keep the small coding-agent and harness
    // icons in the bundle so their marks work with existing servers, without widening their asset allowlist.
    build: { outDir: "dist", assetsInlineLimit: (file) => ["coding-agents", "harnesses"].some(dir => file.replaceAll("\\", "/").includes(`/src/assets/${dir}/`)) },
    // css: tokens.css is read as text (`?raw`) by the design-system test and stories; every other stylesheet stays a stub.
    test: { environment: "jsdom", include: ["src/**/*.test.ts", "src/**/*.test.tsx"], css: { include: [/\.css\?raw$/] }, ...(workers ? { maxWorkers: workers } : {}), ...(projects ? { projects } : {}) },
  };
});
