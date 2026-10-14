import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { BROWSER_TOOLS, WEB_TOOLS, browserSection } from "@parcha/pi-browser";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

test("the core and its entry import only Node builtins, their own files and the package's declared dependencies (no pi, no host)", () => {
  const files = [path.join(SRC, "index.ts"), ...fs.readdirSync(path.join(SRC, "core")).map((name) => path.join(SRC, "core", name))];
  const declared = Object.keys(JSON.parse(fs.readFileSync(path.join(SRC, "..", "package.json"), "utf8")).dependencies ?? {});
  const outside = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const [, specifier] of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) {
      const own = specifier.startsWith(".") && path.resolve(path.dirname(file), specifier).startsWith(path.join(SRC, "core"));
      if (!specifier.startsWith("node:") && !own && !declared.includes(specifier)) outside.push(`${path.relative(SRC, file)} imports ${specifier}`);
    }
  }
  assert.ok(files.length > 5);
  assert.deepEqual(outside, []);
});

test("both entry points resolve by the package's name from its build", async () => {
  const core = await import("@parcha/pi-browser");
  assert.equal(typeof core.classifyBrowserError, "function");
  await import("@parcha/pi-browser/durable");
});

const CALLS = [
  ["snapshot", {}, true],
  ["snapshot", { includeIframes: false }, true],
  ["snapshot", { includeIframes: false, find: "price" }, false],
  ["run", { code: 'await page.goto("https://example.com"); return await page.title();' }, true],
  ["run", { actions: [{ op: "click", id: "1-42" }, { op: "hover", id: "1-7" }] }, true],
  ["run", { actions: [{ op: "fill", id: "2-14", value: "Miami" }, { op: "type", id: "2-15", text: "x", delay: 20 }, { op: "press", id: "2-15", key: "Enter" }] }, true],
  ["run", { actions: [{ op: "select", id: "3-9", values: "Lowest price" }, { op: "select", id: "3-10", values: ["a", "b"] }] }, true],
  ["run", { actions: [{ kind: "click", ref: "1-42" }] }, false],
  ["run", { actions: [{ op: "drag", id: "1-42" }] }, false],
  ["run", { actions: [] }, false],
  ["screenshot", {}, true],
  ["screenshot", { fullPage: true, type: "jpeg", quality: 40, ask: "Is the cookie banner gone?" }, true],
  ["screenshot", { type: "gif" }, false],
  ["browser_read", {}, true],
  ["browser_read", { what: "title" }, true],
  ["browser_read", { what: "pdf" }, false],
  ["browser_release", {}, true],
  ["browser_relaunch", { verified: true, geolocation: { country: "GB", city: "LONDON" } }, true],
  ["browser_relaunch", { geolocation: { city: "LONDON" } }, false],
  ["browser_downloads", {}, true],
  ["web_fetch", { url: "https://example.com/filing", format: "raw" }, true],
  ["web_fetch", { format: "markdown" }, false],
  ["web_search", { query: "delaware file number acme", n: 5 }, true],
  ["web_search", { n: 5 }, false],
];

test("pi validates every tool's arguments against the contract: today's shapes reach the tool, malformed ones never do", async () => {
  const executed = [];
  const tools = [...BROWSER_TOOLS, ...WEB_TOOLS].map((contract) => defineTool({
    name: contract.name, description: contract.description, parameters: contract.parameters, replay: contract.replay, executionMode: contract.executionMode,
    execute: async (args, api) => { executed.push({ callId: api.callId, tool: contract.name, args }); return { content: [{ type: "text", text: "ok" }] }; },
  }));
  const extension = defineExtension({ name: "browser", tools, sections: [{ key: "browser", render: () => browserSection({ idleReleaseS: 180 }) }] });

  const prompts = [];
  let turn = 0;
  const faux = fauxProvider({ models: [{ id: "faux-1" }] });
  faux.setResponses(Array.from({ length: CALLS.length + 1 }, () => (context) => {
    prompts.push(context.messages.filter((m) => m.role === "system").map((m) => m.sections?.browser).filter(Boolean));
    const call = CALLS[turn];
    turn += 1;
    return call ? fauxAssistantMessage([fauxToolCall(call[0], call[1], { id: `call-${turn - 1}` })], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")], { stopReason: "stop" });
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    const settled = await (await root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
    assert.equal(settled.status, "done");
    const results = new Map();
    for (const entry of (await root.entries({}, 500, undefined, ctx)).items) {
      const message = entry.model?.[0];
      if (entry.kind === "pi.tool-result") results.set(message.toolCallId, message);
    }
    CALLS.forEach(([tool, args, valid], index) => {
      const ran = executed.find((e) => e.callId === `call-${index}`);
      const label = `${tool} ${JSON.stringify(args)}`;
      assert.equal(results.get(`call-${index}`)?.isError ?? null, !valid, `${label}: result`);
      assert.equal(Boolean(ran), valid, `${label}: execute`);
      if (valid) for (const [key, value] of Object.entries(args)) assert.deepEqual(ran.args[key], value, `${label}: ${key}`);
    });
    const section = `<browser>\n${browserSection({ idleReleaseS: 180 })}\n</browser>`;
    assert.ok(prompts.length === CALLS.length + 1 && prompts.every((shown) => shown.length === 1 && shown[0] === section), "every request carries the section once, unchanged");
  } finally {
    await harness.close(ctx);
  }
});

test("every package the built code imports at run time is declared as a dependency or a peer, so a strict install layout resolves it", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "..", "package.json"), "utf8"));
  const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
  const files = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (full.endsWith(".ts")) files.push(full); } };
  walk(SRC);
  const undeclared = [];
  for (const file of files) {
    // A type-only import is erased from the build; the runtime ones (import, dynamic import, literal require) are what
    // a missing package breaks.
    const source = fs.readFileSync(file, "utf8").replace(/^\s*(?:import|export)\s+type\b[^;]*;/gm, "");
    for (const [, specifier] of source.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g)) {
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
      if (!declared.has(name)) undeclared.push(`${path.relative(SRC, file)} imports ${name}`);
    }
  }
  assert.ok(files.length > 30);
  assert.deepEqual(undeclared, []);
});

const manifestOf = () => JSON.parse(fs.readFileSync(path.join(SRC, "..", "package.json"), "utf8"));
const walkFiles = (dir, ext) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walkFiles(full, ext) : full.endsWith(ext) ? [full] : [];
});
const packageOf = (specifier) => (specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]);

test("a type the sources import is declared too, so the package builds outside this workspace", () => {
  const manifest = manifestOf();
  const declared = new Set(["dependencies", "peerDependencies", "devDependencies"].flatMap((field) => Object.keys(manifest[field] ?? {})));
  const undeclared = [];
  for (const file of walkFiles(SRC, ".ts")) {
    for (const [, specifier] of fs.readFileSync(file, "utf8").matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) {
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      if (!declared.has(packageOf(specifier))) undeclared.push(`${path.relative(SRC, file)} imports ${packageOf(specifier)}`);
    }
  }
  assert.deepEqual(undeclared, []);
});

test("the emitted declarations name only packages a consumer's install has: dependencies and peers, never a dev dependency", () => {
  const manifest = manifestOf();
  const shipped = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
  const named = [];
  for (const file of walkFiles(path.join(SRC, "..", "dist"), ".d.ts")) {
    for (const [, specifier] of fs.readFileSync(file, "utf8").matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) {
      if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
      if (!shipped.has(packageOf(specifier))) named.push(`${path.relative(SRC, file)} names ${packageOf(specifier)}`);
    }
  }
  assert.deepEqual(named, []);
});

test("importing the package has no effect: sideEffects is false, and loading every entry leaves WebSocket, fetch and the proxy variables alone", () => {
  const manifest = manifestOf();
  assert.equal(manifest.sideEffects, false, "a bundler may drop an entry the host never calls");
  const entries = Object.entries(manifest.exports).map(([key]) => (key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`));
  const probe = `
    const before = { ws: globalThis.WebSocket, fetch: globalThis.fetch, noProxy: process.env.NO_PROXY, lower: process.env.no_proxy };
    for (const entry of ${JSON.stringify(entries)}) await import(entry);
    const after = { ws: globalThis.WebSocket, fetch: globalThis.fetch, noProxy: process.env.NO_PROXY, lower: process.env.no_proxy };
    console.log(JSON.stringify(Object.keys(before).filter((key) => before[key] !== after[key])));
  `;
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: path.join(SRC, ".."), encoding: "utf8", env: { ...process.env, NO_PROXY: "", no_proxy: "" } });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), []);
});

test("pi-durable and chord are bounded from the version a leg measured to below 1.3.0, the dev pins sit inside, and the pi coding agent stays an unbounded peer as pi's package guidance says", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "..", "package.json"), "utf8"));
  // 1.0.4 cannot build the durable adapter: use_website reads a child's last report by scanning entries in descending order, which 1.1 added.
  const floors = { "@earendil-works/chord": "1.1.0", "@earendil-works/pi-durable": "1.1.0" };
  const parts = (version) => version.split(".").map(Number);
  const compare = (a, b) => { const [x, y] = [parts(a), parts(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  const peers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => name.startsWith("@earendil-works/"));
  assert.deepEqual(peers.map(([name]) => name).sort(), [...Object.keys(floors), "@earendil-works/pi-coding-agent"].sort());
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  for (const [name, floor] of Object.entries(floors)) {
    const range = manifest.peerDependencies[name];
    assert.equal(range, `>=${floor} <1.3.0`, `${name} starts at its measured floor and ends below 1.3.0`);
    const pin = manifest.devDependencies?.[name];
    if (pin) assert.ok(compare(pin, floor) >= 0 && compare(pin, "1.3.0") < 0, `${name} is developed on ${pin}, outside ${range}`);
  }
});
