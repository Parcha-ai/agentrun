// An agent's FIRST saved sign-in on the runner, made at the run's launch as main's forRun makes it (sign-ins.ts): a run
// whose agent saved none for its browser's vendor has a vendor object made for it (a Browserbase context, a Kernel
// profile), at the vendor's REST API, with THAT run's claim keys (its claim-secrets env, never the process's), its pointer
// sealed and saved at once, and the run handed it to save; its sessions open on the profile with save on, and their
// release verifies it. The agent's next run is handed that pointer. A create that fails starts the run signed out, in
// words naming no pointer; a create that another run's save beat goes at the vendor, and the run takes the saved one.
// The vendors' APIs are the faux one (fixtures/faux-vendor-api.mjs, noting each call's key); the browser is the faux one.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import * as faux from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { calls as vendorCalls } from "./fixtures/faux-vendor-api.mjs";
import { storeOn } from "./store-helpers.mjs";
import { withEnv } from "./support.mjs";

const signIns = await import("../dist/sign-ins-store.js");
const tools = await import("../dist/tools.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { TOOL_PLANE_ENV } = await import("../dist/tool-plane.js");
const { hostLifecycle } = await import("../dist/runner/adapter-loop.js");

const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const FAUX_VENDORS = new URL("./fixtures/faux-vendor-api.mjs", import.meta.url).pathname;
/** A test seal key, no real one. */
const KEY = randomBytes(32);
const LEASE = 60_000;
/** Test keys, no real ones: each run's own, as its claim reads them from the store. */
const keysOf = (run) => ({ BROWSERBASE_API_KEY: `bb-key-${run}`, BROWSERBASE_PROJECT_ID: `project-${run}`, KERNEL_API_KEY: `kernel-key-${run}` });

/** One runner's store with agents c and d (no sign-in saved), runs c, c2 (of c) and d, each claimed. */
async function runner(t) {
  const s = await storeOn(t);
  const log = join(s.dir, "browser.jsonl");
  writeFileSync(log, "");
  withEnv(t, { FAUX_BROWSER_LOG: log }, ["FAUX_BROWSER_LOG", "AGENTRUN_TEST_FAUX_VENDOR_DOWN"]);
  vendorCalls.length = 0;
  for (const agent of ["c", "d"]) await s.store.agents.create({ id: `agent-${agent}`, name: agent }, { id: `rev-${agent}`, kind: "agentic", body: { instructions: "Browse.", tools: ["browser"] } });
  const claims = {};
  for (const [run, agent] of [["run-c", "c"], ["run-c2", "c"], ["run-d", "d"]]) {
    await s.store.runs.create({ id: run, agentId: `agent-${agent}`, revisionId: `rev-${agent}` });
    claims[run] = await s.store.claim(run, "runner-1", { leaseMs: LEASE });
  }
  const lines = (op) => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.op === op);
  /** The run's ToolHost as the runner's: its store, claim and seal key, its claim's keys in its env. */
  const hostOf = (run, vendor, more = {}) => {
    const root = join(s.dir, "runs", run);
    mkdirSync(join(root, "work"), { recursive: true });
    const env = { [FAUX_ENV]: "faux", [tools.FAUX_BROWSER_ENV]: FAUX_BROWSER, [tools.FAUX_VENDOR_API_ENV]: FAUX_VENDORS, [TOOL_PLANE_ENV]: JSON.stringify({ browser: vendor }), ...keysOf(run) };
    return { where: { root, work: join(root, "work"), ref: { id: run } }, env, install() {}, onConversation() {}, beforeResume() {}, beforeRelease() {}, handoverInJournal: true, store: s.store, claim: claims[run], sealKey: KEY, ...more };
  };
  const saved = async (agent, vendor) => {
    const row = await s.store.signIns.get(`agent-${agent}`, vendor);
    return row ? (await signIns.openSavedPointer(s.store, KEY, `agent-${agent}`, vendor))?.pointer : undefined;
  };
  return { ...s, claims, lines, hostOf, saved };
}

/** Everything the process writes to its own output while `work` runs. */
async function said(work) {
  const out = [];
  const original = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) { out.push(String(chunk)); return original.call(this, chunk, ...rest); };
  try {
    return { value: await work(), out: out.join("") };
  } finally {
    process.stderr.write = original;
  }
}

test("a run whose agent saved no Browserbase sign-in has a context made at its launch with its own claim's key, saved at once and handed to it to save; the agent's next run is handed that same context, to read", async (t) => {
  const r = await runner(t);
  assert.equal(typeof tools.FAUX_VENDOR_API_ENV, "string", "tools.ts names the faux vendor API's variable");
  await tools.TOOLS.browser.bind(r.hostOf("run-c", "browserbase"));
  const [first] = r.lines("sign-in");
  assert.ok(first, "the run was handed a sign-in");
  assert.match(first.ref, /^ctx-made-/);
  assert.deepEqual({ provider: first.provider, save: first.save, ref_in_env: first.ref_in_env }, { provider: "browserbase", save: true, ref_in_env: false });
  assert.equal(await r.saved("c", "browserbase"), first.ref, "its pointer saved for the agent at once");
  assert.deepEqual((await r.store.runs.get("run-c")).signInHanded, [signIns.pointerHash(first.ref)]);
  assert.deepEqual(vendorCalls.map(({ method, path, key }) => ({ method, path, key })), [{ method: "POST", path: "/v1/contexts", key: "bb-key-run-c" }], "one context, made with run-c's own key");
  await tools.TOOLS.browser.bind(r.hostOf("run-c2", "browserbase"));
  const second = r.lines("sign-in")[1];
  assert.deepEqual({ ref: second?.ref, save: second?.save }, { ref: first.ref, save: false }, "the agent's next run is handed it, to read while run-c holds it");
  assert.equal(vendorCalls.length, 1, "nothing more made");
});

test("on Kernel, a profile is made at its launch with the run's own claim key, its name the pointer saved", async (t) => {
  const r = await runner(t);
  await tools.TOOLS.browser.bind(r.hostOf("run-d", "kernel"));
  const [handed] = r.lines("sign-in");
  assert.match(handed?.ref ?? "", /^agentrun-[0-9a-f]{24}$/);
  assert.equal(handed.save, true);
  assert.equal(await r.saved("d", "kernel"), handed.ref);
  assert.deepEqual(vendorCalls.map(({ method, path, key }) => ({ method, path, key })), [{ method: "POST", path: "/profiles", key: "kernel-key-run-d" }]);
});

test("each run's first sign-in is made with that run's claim keys alone: run c's never with run d's, and neither from the process's environment", async (t) => {
  const r = await runner(t);
  await Promise.all([tools.TOOLS.browser.bind(r.hostOf("run-c", "browserbase")), tools.TOOLS.browser.bind(r.hostOf("run-d", "browserbase"))]);
  assert.deepEqual(vendorCalls.map((call) => call.key).sort(), ["bb-key-run-c", "bb-key-run-d"], "each made with its own run's key");
  assert.notEqual(await r.saved("c", "browserbase"), await r.saved("d", "browserbase"), "each agent its own context");
  for (const run of ["run-c", "run-d"]) assert.ok(!Object.values(process.env).some((value) => String(value).includes(`bb-key-${run}`)), "no claim key in process.env");
});

test("a create that fails at the vendor starts the run signed out, saying so in words that name no pointer, and saves nothing", async (t) => {
  const r = await runner(t);
  process.env.AGENTRUN_TEST_FAUX_VENDOR_DOWN = "1";
  const { out } = await said(() => tools.TOOLS.browser.bind(r.hostOf("run-c", "browserbase")));
  assert.deepEqual(r.lines("sign-in"), [], "signed out");
  assert.equal(await r.saved("c", "browserbase"), undefined, "nothing saved");
  assert.match(out, /run-c: its browser starts signed out: browserbase answered 503/);
  assert.ok(!/ctx-|bb-key/.test(out), `no pointer or key in the words: ${out}`);
});

test("a create another run's save beat goes at the vendor, and the run is handed the saved sign-in instead", async (t) => {
  const r = await runner(t);
  const winner = `ctx-winner-${randomBytes(6).toString("hex")}`;
  const removed = [];
  const vendors = {
    create: async () => {
      await signIns.saveSignIn(r.store, KEY, { agentId: "agent-c", provider: "browserbase", pointer: winner });
      return "ctx-ours";
    },
    remove: async (vendor, ref) => void removed.push([vendor, ref]),
  };
  const handed = await signIns.runSignIn(r.store, KEY, r.claims["run-c"], "browserbase", { vendors });
  assert.equal(handed?.ref, winner, "the saved one");
  assert.deepEqual(removed, [["browserbase", "ctx-ours"]], "ours went at the vendor");
  assert.equal(await r.saved("c", "browserbase"), winner);
});

test("the made sign-in's sessions open on its profile with save on, and their release verifies it", { timeout: 120_000 }, async (t) => {
  const r = await runner(t);
  const lifecycle = hostLifecycle();
  const registry = createRegistry();
  const host = r.hostOf("run-c", "browserbase", { install: (extension) => registry.install(extension), ...lifecycle.register });
  const binding = await tools.TOOLS.browser.bind(host);
  const model = faux.fauxProvider({ models: [{ id: "faux-1" }] });
  model.setResponses(Array.from({ length: 4 }, () => (context) => (context.messages.some((m) => m.role === "toolResult") ? faux.fauxAssistantMessage([faux.fauxText("done")], { stopReason: "stop" }) : faux.fauxAssistantMessage([faux.fauxToolCall("snapshot", {})], { stopReason: "toolUse" }))));
  const models = createModels();
  models.setProvider(model.provider);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx).catch(() => undefined));
  const conversation = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, tools: binding.tools }, init: async (tx, id) => { for (const write of lifecycle.onConversation) await write(tx, Number(id)); } });
  for (const settle of lifecycle.beforeResume) await settle(harness);
  await (await conversation.submit({ type: "input", content: "Browse." }, ctx)).wait(ctx);
  assert.deepEqual(r.lines("profile").map(({ name, save }) => ({ name, save })), [{ name: "default", save: true }], "its session opened on the profile, saving");
  for (const stop of lifecycle.beforeRelease) await stop(harness);
  assert.ok((await signIns.signInViews(r.store, KEY, "agent-c"))[0]?.verified_at, "its release verified the sign-in");
});
