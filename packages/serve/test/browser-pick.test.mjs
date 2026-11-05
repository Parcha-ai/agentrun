// Picking the browser: `browser` is a tool-plane capability with a provider choice, as web_search is. `auto` is
// Browserbase where the server holds its keys, else Kernel where it holds Kernel's, else unavailable with why; a vendor
// picked is that vendor or unavailable, never the other; `chrome` is refused by name. The agent's pick wins over the
// server's, a run keeps the vendor its first launch resolved, and one whose key is gone since is unavailable. Kernel's
// key is saved, sealed and checked free like the other tool keys. No network: the vendors are the tests' fakes.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CHECK_MS, checkKey, KEY_CHECKS } from "../dist/key-check.js";
import { FAUX_ENV } from "../dist/model.js";
import { keptFromBefore, NO_BROWSER_KEY, NO_CHROME, planeFor, recheckPlane, resolveCapability, settingsIssues, TOOL_PLANE_ENV } from "../dist/tool-plane.js";
import { FAUX_BROWSER_ENV, TOOLS } from "../dist/tools.js";
import { calls as kernelCalls, KEY as KERNEL_KEY } from "./fixtures/faux-kernel-check.mjs";
import { agent, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const FAUX_KERNEL = new URL("./fixtures/faux-kernel-check.mjs", import.meta.url).pathname;
const FAUX_BROWSERBASE = new URL("./fixtures/faux-browserbase-check.mjs", import.meta.url).pathname;
const KEYS = ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY", "AGENTRUN_SEAL_KEY", "FAUX_BROWSER_LOG"];
const BB = { BROWSERBASE_API_KEY: "fake-test-key", BROWSERBASE_PROJECT_ID: "fake-project" };
const KERNEL = { KERNEL_API_KEY: "fake-test-key" };
const base = { harness: "pi", gateway: false, parallelKey: false };
/** A key Kernel's fake refuses, built so it reads as no credential. */
const WRONG = ["sk", "kernel", "wrong", "12345"].join("_");
const browserIn = (env, picks = {}) => resolveCapability("browser", { ...base, browserKeys: { browserbase: Boolean(env.BROWSERBASE_API_KEY && env.BROWSERBASE_PROJECT_ID), kernel: Boolean(env.KERNEL_API_KEY) }, ...picks });

test("auto: Browserbase where its keys are held, else Kernel where its key is, else unavailable with why; a vendor picked is that one or unavailable, never the other; chrome is refused by name", () => {
  assert.equal(browserIn(BB), "browserbase", "only Browserbase's keys");
  assert.equal(browserIn(KERNEL), "kernel", "only Kernel's");
  assert.equal(browserIn({ ...BB, ...KERNEL }), "browserbase", "both: Browserbase first");
  assert.equal(browserIn({ BROWSERBASE_API_KEY: "fake-test-key", ...KERNEL }), "kernel", "half of Browserbase's is none of it");
  assert.equal(browserIn({}), NO_BROWSER_KEY);
  assert.match(NO_BROWSER_KEY, /^unavailable: no browser key: .*BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.*KERNEL_API_KEY/);
  assert.equal(browserIn({ ...BB, ...KERNEL }, { pick: "kernel" }), "kernel", "the server's pick");
  assert.equal(browserIn(BB, { pick: "kernel" }), "unavailable: kernel picked, no KERNEL_API_KEY", "never Browserbase in its place");
  assert.equal(browserIn(KERNEL, { pick: "browserbase" }), "unavailable: browserbase picked, no BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID");
  assert.equal(browserIn({ ...BB, ...KERNEL }, { pick: "kernel", override: "browserbase" }), "browserbase", "the agent's pick over the server's");
  assert.equal(browserIn({ ...BB, ...KERNEL }, { pick: "browserbase", override: "kernel" }), "kernel");
  for (const picks of [{ pick: "chrome" }, { override: "chrome" }]) assert.equal(browserIn({ ...BB, ...KERNEL }, picks), NO_CHROME, JSON.stringify(picks));
  assert.equal(NO_CHROME, "unavailable: a local Chrome is not set up on this server");
  // The choices a setting may name, the server's or an agent's: chrome among them, anything else refused by field.
  assert.deepEqual(settingsIssues({ browser: { provider: "chrome" } }), []);
  assert.deepEqual(settingsIssues({ browser: { provider: "local" } }, "definition.tool_settings").map((i) => [i.field, i.reason, i.message]), [["definition.tool_settings.browser.provider", "not_an_option", "definition.tool_settings.browser.provider is one of auto, browserbase, kernel, chrome"]]);
});

test("a run's plane names its browser from the server's keys, set or saved; a later launch keeps it, but a vendor whose key is gone is unavailable, never the other, and web_fetch's own kernel is no vendor", () => {
  const tooling = { tools: ["browser", "web_fetch"], harness: "pi" };
  assert.equal(planeFor(KERNEL, tooling, {}).browser, "kernel");
  assert.equal(planeFor({ ...BB, ...KERNEL }, tooling, {}).browser, "browserbase");
  assert.equal(planeFor({ ...BB, ...KERNEL }, { ...tooling, overrides: { browser: { provider: "kernel" } } }, { browser: { provider: "browserbase" } }).browser, "kernel", "the agent's own over the server's");
  assert.equal(planeFor(BB, { tools: ["web_fetch"], harness: "pi" }, {}).browser, undefined, "a revision that names no browser has none");
  const kept = { browser: "kernel", web_fetch: "kernel" };
  assert.deepEqual(recheckPlane(kept, KERNEL), kept);
  assert.deepEqual(recheckPlane(kept, BB), { browser: "unavailable: kernel picked, no KERNEL_API_KEY", web_fetch: "kernel" }, "Kernel's key gone: unavailable, and the guarded fetch stays");
  assert.deepEqual(recheckPlane({ browser: "browserbase" }, { BROWSERBASE_API_KEY: "fake-test-key", ...KERNEL }), { browser: "unavailable: browserbase picked, no BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID" });
  assert.deepEqual(recheckPlane({ browser: NO_CHROME }, { ...BB, ...KERNEL }), { browser: NO_CHROME }, "an unavailable browser stays so");
  // A run made before its plane was kept, resolved at a later launch: Browserbase, the vendor it had, never today's pick.
  const today = planeFor({ ...BB, ...KERNEL }, tooling, { browser: { provider: "kernel" } });
  assert.deepEqual(keptFromBefore(today, { ...BB, ...KERNEL }), { browser: "browserbase", web_fetch: "kernel" });
  assert.deepEqual(keptFromBefore(today, KERNEL).browser, "unavailable: browserbase picked, no BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID");
  assert.deepEqual(keptFromBefore({ web_fetch: "kernel" }, KERNEL), { web_fetch: "kernel" }, "no browser, none added");
});

test("the browser lists browser_downloads only on a vendor that keeps a session's downloads: Browserbase does, Kernel does not; upload is listed on both", async (t) => {
  const { kernelProvider } = await import("@parcha/pi-browser/providers/kernel");
  const { browserbaseProvider } = await import("@parcha/pi-browser/providers/browserbase");
  assert.equal(kernelProvider({ env: {} }).downloads, undefined, "Kernel's provider has no downloads");
  assert.equal(typeof browserbaseProvider({ env: {} }).downloads, "object", "Browserbase's has");
  const work = await scratch(t);
  const toolsOf = async (vendor) => {
    const env = { [FAUX_ENV]: "faux", [FAUX_BROWSER_ENV]: FAUX_BROWSER, [TOOL_PLANE_ENV]: JSON.stringify({ browser: vendor }) };
    const host = { where: { work, ref: { id: "run" } }, env, install() {}, onConversation() {}, beforeResume() {}, beforeRelease() {} };
    return (await TOOLS.browser.bind(host)).tools.map((tool) => tool.name);
  };
  const kernel = await toolsOf("kernel");
  assert.ok(kernel.includes("browser_upload") && !kernel.includes("browser_downloads"), kernel.join(", "));
  const bb = await toolsOf("browserbase");
  assert.ok(bb.includes("browser_upload") && bb.includes("browser_downloads"), bb.join(", "));
});

test("Kernel's key check: one free call, a list of at most one browser, on the key, given 5 s, at the base the provider sends to; 401 refuses the key in plain words", async () => {
  const call = KEY_CHECKS.kernel("not-a-key", {});
  assert.deepEqual(call, { url: "https://api.onkernel.com/browsers?limit=1", headers: { authorization: "Bearer not-a-key" } }, "a GET: no method or body");
  assert.equal(KEY_CHECKS.kernel("k", { KERNEL_BASE_URL: "https://kernel.example/" }).url, "https://kernel.example/browsers?limit=1");
  assert.equal(CHECK_MS, 5_000);
  const row = { id: "kernel", label: "Kernel" };
  assert.equal((await checkKey(row, KERNEL_KEY, {}, (await import(FAUX_KERNEL)).default)).state, "accepted");
  const refused = await checkKey(row, WRONG, {}, (await import(FAUX_KERNEL)).default);
  assert.deepEqual(refused, { state: "refused", message: "Kernel refused this key (401: Invalid API key)" });
});

test("pick the browser through the API: a Kernel key saved and checked, Kernel picked for the server, and a run gets Kernel while an agent that picks Browserbase gets Browserbase; capabilities, settings and each run's plane say which", { timeout: 90_000 }, async (t) => {
  const log = join(await scratch(t), "browser.jsonl");
  withEnv(t, { ...BB, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const { api, data } = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxKernel: FAUX_KERNEL });
  const browserTool = async () => (await api("GET", "/capabilities")).body.tools.find((tool) => tool.name === "browser");
  assert.deepEqual([(await browserTool()).provider, (await browserTool()).resolves.pi], ["auto", "browserbase"], "auto, on the server's Browserbase keys");

  // Kernel's key: refused by its fake with a wrong one (nothing kept), then saved, sealed and checked on the right one.
  const checked = kernelCalls.length;
  const wrong = await api("PUT", "/settings/tool-keys/kernel", { values: { KERNEL_API_KEY: WRONG } });
  assert.deepEqual([wrong.status, wrong.body.error.fields.map((f) => [f.field, f.reason, f.message])], [422, [["values.KERNEL_API_KEY", "refused_by_provider", "Kernel refused this key (401: Invalid API key)"]]]);
  assert.equal((await api("PUT", "/settings/tool-keys/kernel", { values: { KERNEL_API_KEY: KERNEL_KEY } })).status, 204);
  assert.deepEqual(kernelCalls.slice(checked).map((c) => [c.method, c.path, c.search, c.authorized]), [["GET", "/browsers", "?limit=1", false], ["GET", "/browsers", "?limit=1", true]]);
  const row = (await api("GET", "/settings/tool-keys")).body.keys.find((key) => key.id === "kernel");
  assert.deepEqual([row.label, row.unlocks, row.fields, row.check.state], ["Kernel", ["browser"], [{ name: "KERNEL_API_KEY", set: true, source: "stored" }], "accepted"]);
  assert.ok(!(await readFile(join(data, "tool-keys.json"), "utf8")).includes(KERNEL_KEY), "kept sealed");

  // Kernel picked for the server: settings and capabilities say so at once.
  const put = await api("PUT", "/settings/tools", { browser: { provider: "kernel" } });
  assert.deepEqual([put.status, put.body.browser], [200, { provider: "kernel" }]);
  assert.deepEqual((await api("GET", "/settings/tools")).body.browser, { provider: "kernel" });
  const listed = await browserTool();
  assert.deepEqual([listed.available, listed.providers, listed.provider, listed.default_provider, listed.resolves.pi, listed.why.pi], [true, ["auto", "browserbase", "kernel", "chrome"], "kernel", "auto", "kernel", "Kernel, picked in settings"]);

  // Two agents: one on the server's pick, one that picks Browserbase for itself.
  assert.equal((await api("POST", "/agents", agent("kern", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  assert.equal((await api("POST", "/agents", agent("bb", { instructions: "Browse.", tools: ["browser"], tool_settings: { browser: { provider: "browserbase" } } }))).status, 201);
  assert.deepEqual((await api("GET", "/agents/kern")).body.tools, [{ name: "browser", provider: "kernel", provider_from: "server", default_provider: "kernel", resolved: "kernel" }]);
  assert.deepEqual((await api("GET", "/agents/bb")).body.tools, [{ name: "browser", provider: "browserbase", provider_from: "agent", default_provider: "kernel", resolved: "browserbase" }]);

  const browse = async (id) => {
    const before = (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: "Browse the example page." } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    await follow(api, started.body.run_id, ["completed"]);
    const ops = (await readFile(log, "utf8")).trim().split("\n").slice(before).map((line) => JSON.parse(line));
    const meta = JSON.parse(await readFile(join(data, "runs", started.body.run_id, "serve.json"), "utf8"));
    return { answer: (await api("GET", `/runs/${started.body.run_id}`)).body.result.final_answer, vendor: ops.find((op) => op.op === "vendor"), ops: ops.map((op) => op.op), plane: meta.tool_plane };
  };
  const kern = await browse("kern");
  assert.deepEqual(kern.vendor, { op: "vendor", vendor: "kernel", KERNEL_API_KEY: "set" }, "the run's process built Kernel's browser, with the saved key");
  assert.match(kern.answer, /The answer is forty-two\. This browser is kernel's\./);
  assert.equal(kern.plane.browser, "kernel", "the run's plane, kept for its life");
  assert.ok(kern.ops.includes("create") && kern.ops.includes("release"), JSON.stringify(kern.ops));
  const bb = await browse("bb");
  assert.equal(bb.vendor.vendor, "browserbase");
  assert.match(bb.answer, /This browser is browserbase's\./);
  assert.equal(bb.plane.browser, "browserbase");

  // Chrome picked: refused by name, in capabilities and at a run.
  assert.equal((await api("PUT", "/settings/tools", { browser: { provider: "chrome" } })).status, 200);
  assert.deepEqual([(await browserTool()).available, (await browserTool()).reason], [false, "a local Chrome is not set up on this server"]);
  const refused = await api("POST", "/agents/kern/runs", { input: { content: "Browse the example page." } });
  assert.deepEqual([refused.status, refused.body.error.code], [409, "agent_not_runnable"]);
  assert.match(refused.body.error.message, /The tool browser does not run here on pi: a local Chrome is not set up on this server\./);
});

/** The browser in capabilities once the start's check of `id`'s key has answered (at most 10 s). */
async function checkedBrowser(api, id) {
  for (const until = Date.now() + 10_000; ;) {
    const row = (await api("GET", "/settings/tool-keys")).body.keys.find((key) => key.id === id);
    if (row.check !== null || Date.now() > until) return (await api("GET", "/capabilities")).body.tools.find((tool) => tool.name === "browser");
    await new Promise((go) => setTimeout(go, 50));
  }
}

test("a vendor's key the server starts with and the vendor refuses leaves the browser unavailable, saying so; auto stays on that vendor, never the other, as a refused Parallel key never moves web_search", async (t) => {
  // Browserbase's refused, Kernel's good: auto still resolves to Browserbase, and reads unavailable for its refused key.
  withEnv(t, { BROWSERBASE_API_KEY: WRONG, BROWSERBASE_PROJECT_ID: "proj-1", KERNEL_API_KEY: KERNEL_KEY }, KEYS);
  const first = await serve(t, { fauxBrowserbase: FAUX_BROWSERBASE, fauxKernel: FAUX_KERNEL });
  const bb = await checkedBrowser(first.api, "browserbase");
  assert.deepEqual([bb.available, bb.resolves.pi, bb.reason], [false, "browserbase", "Browserbase refused BROWSERBASE_API_KEY (401: Unauthorized) when this server started: set the right one where AgentRun starts, then restart it"]);
  // Kernel picked, its key refused at the start: unavailable, in Kernel's words.
  withEnv(t, { KERNEL_API_KEY: WRONG }, KEYS);
  const second = await serve(t, { fauxBrowserbase: FAUX_BROWSERBASE, fauxKernel: FAUX_KERNEL });
  assert.equal((await second.api("PUT", "/settings/tools", { browser: { provider: "kernel" } })).status, 200);
  const kernel = await checkedBrowser(second.api, "kernel");
  assert.deepEqual([kernel.available, kernel.resolves.pi, kernel.reason], [false, "kernel", "Kernel refused KERNEL_API_KEY (401: Invalid API key) when this server started: set the right one where AgentRun starts, then restart it"]);
});

test("a run made before the browser was pickable keeps Browserbase when it is launched again, though the server now picks Kernel", { timeout: 90_000 }, async (t) => {
  const log = join(await scratch(t), "browser.jsonl");
  withEnv(t, { ...BB, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), FAUX_BROWSER_LOG: log }, KEYS);
  const first = await serve(t, { fauxBrowser: FAUX_BROWSER, fauxKernel: FAUX_KERNEL });
  assert.equal((await first.api("POST", "/agents", agent("old", { instructions: "Browse.", tools: ["browser"] }))).status, 201);
  const started = await first.api("POST", "/agents/old/runs", { input: { content: "Browse the example page." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const { after } = await follow(first.api, started.body.run_id, ["completed"]);
  await first.close();
  // As a run made before this server kept its browser: no plane in its serve.json.
  const file = join(first.data, "runs", started.body.run_id, "serve.json");
  const { tool_plane: _, ...meta } = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify(meta));
  const { api } = await serve(t, { data: first.data, fauxBrowser: FAUX_BROWSER, fauxKernel: FAUX_KERNEL });
  assert.equal((await api("PUT", "/settings/tool-keys/kernel", { values: { KERNEL_API_KEY: KERNEL_KEY } })).status, 204);
  assert.equal((await api("PUT", "/settings/tools", { browser: { provider: "kernel" } })).status, 200);
  const before = (await readFile(log, "utf8")).trim().split("\n").length;
  assert.equal((await api("POST", `/runs/${started.body.run_id}/messages`, { content: "Browse the example page again." })).status, 202);
  await follow(api, started.body.run_id, ["completed"], { after });
  const vendors = (await readFile(log, "utf8")).trim().split("\n").slice(before).map((line) => JSON.parse(line)).filter((op) => op.op === "vendor");
  assert.deepEqual(vendors.map((op) => op.vendor), ["browserbase"], "the vendor it had, never today's pick");
  assert.equal(JSON.parse(await readFile(file, "utf8")).tool_plane.browser, "browserbase", "and kept so from now on");
});
