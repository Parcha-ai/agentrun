#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { findChrome } from "@parcha/pi-browser/coding-agent";
import { startLiveGrid } from "./live-grid.mjs";

const USAGE = `usage: node main.mjs [--provider cdp|browserbase|kernel] [--children N] [--model ID] [--base-url URL] [--port N] [--headed] [--local-only] [--chrome PATH]

  --provider    cdp starts a local headless Chrome per child (the default); browserbase needs BROWSERBASE_API_KEY, kernel KERNEL_API_KEY
  --children    the most browsers one task opens (default 10)
  --model       the model every agent uses (default gpt-6-luna), on an OpenAI Responses endpoint:
  --base-url    that endpoint (default LITELLM_BASE_URL, else OPENAI_BASE_URL, else https://api.openai.com/v1); the key is LITELLM_API_KEY or OPENAI_API_KEY,
                and a broker on this machine (127.0.0.1) needs none
  --local-only  local Chrome reaches only this machine's loopback sites (for testing against a local site)`;

const { values: o } = parseArgs({
  options: {
    provider: { type: "string", default: "cdp" }, children: { type: "string", default: "10" }, model: { type: "string", default: "gpt-6-luna" },
    "base-url": { type: "string" }, port: { type: "string", default: "0" }, headed: { type: "boolean", default: false },
    "local-only": { type: "boolean", default: false }, chrome: { type: "string" }, help: { type: "boolean", default: false },
  },
});
if (o.help) { console.log(USAGE); process.exit(0); }
const fail = (message) => { console.error(`live-grid: ${message}\n\n${USAGE}`); process.exit(2); };

const env = process.env;
const baseUrl = (o["base-url"] ?? env.LITELLM_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(baseUrl).hostname);
const apiKey = env.LITELLM_API_KEY || env.OPENAI_API_KEY || (loopback ? "unused-by-a-local-broker" : "");
if (!apiKey) fail("no model key: set LITELLM_API_KEY or OPENAI_API_KEY (a broker on this machine needs none)");
const children = Number(o.children);
if (!Number.isInteger(children) || children < 1 || children > 10) fail("--children is 1 to 10");

const root = await mkdtemp(path.join(os.tmpdir(), "live-grid-"));
const modelRuntime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
modelRuntime.registerProvider("live-grid", {
  api: "openai-responses", baseUrl: /\/v1$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`, apiKey,
  models: [{ id: o.model, name: o.model, reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 400_000, maxTokens: 32_000 }],
});
const model = modelRuntime.getModel("live-grid", o.model);

let provider;
if (o.provider === "browserbase") {
  if (!(env.BROWSERBASE_API_KEY || env.BB_API_KEY)) fail("--provider browserbase needs BROWSERBASE_API_KEY");
  provider = (await import("@parcha/pi-browser/providers/browserbase")).browserbaseProvider({ env });
} else if (o.provider === "kernel") {
  if (!env.KERNEL_API_KEY) fail("--provider kernel needs KERNEL_API_KEY");
  provider = (await import("@parcha/pi-browser/providers/kernel")).kernelProvider({ env });
} else if (o.provider === "cdp") {
  const executablePath = o.chrome ?? env.PI_BROWSER_CHROME ?? findChrome(env);
  if (!executablePath) fail("no Chrome found: pass --chrome PATH or set PI_BROWSER_CHROME");
  const args = o["local-only"] ? ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] : [];
  provider = (await import("@parcha/pi-browser/providers/cdp")).cdpProvider({ chrome: { executablePath, profileRoot: path.join(root, "profiles"), headless: !o.headed, args } });
} else fail(`--provider is cdp, browserbase or kernel, not "${o.provider}"`);

const grid = await startLiveGrid({ makeProvider: () => provider, models: { modelRuntime, parent: model, child: model }, maxChildren: children, port: Number(o.port), root: path.join(root, "work"), env });
console.log(`live-grid: open ${grid.url} (provider ${o.provider}, up to ${children} browsers, model ${o.model}); Ctrl-C releases every browser and quits`);

let quitting = false;
const quit = async () => {
  if (quitting) return;
  quitting = true;
  console.log("live-grid: releasing browsers");
  await grid.close();
  const tiles = grid.tiles();
  console.log(`live-grid: ${tiles.reduce((n, tile) => n + tile.released, 0)} of ${tiles.reduce((n, tile) => n + tile.created, 0)} browsers of the last task released`);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
