// A run's process is handed its pinned model's key (run-child-host.ts, claim-secrets.ts claimSecrets scoped by the
// launch's model), never a key of the host's default now, which a key saved since its start moved: its route never sends
// that one. A --faux start, pinned to the faux model, is handed no model key at all: the faux model sends none, so not its
// revision's model's either, nor a gateway's. And a run pinned to a model whose key is saved in Settings alone runs on it end to end, in the runner and in a
// process of its own, though the claim lays its model keys never enumerable.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { storeOn } from "./store-helpers.mjs";

// No host model setting or model key from this process reaches the runs below.
for (const name of Object.keys(process.env)) if (/^(AGENT_MODEL|ANTHROPIC_|OPENAI_|OPENROUTER_|AWS_)/.test(name)) delete process.env[name];

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { childLoops } = await import("../dist/runner/run-child-host.js");
const { launchBody } = await import("../dist/run-launch.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { MODEL_KEY_NAMES } = await import("../dist/runner/claim-secrets.js");
const { FAUX_ENV } = await import("../dist/model.js");
const { saveGateway } = await import("../dist/model-gateway.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { heldRedactor } = await import("../dist/runner/redact.js");
const { createDispatchLoop } = await import("../dist/runner/dispatch.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { adapterRunSpecFromLaunch } = await import("../dist/runner/adapter-run-spec.js");
const { routeOf } = await import("../dist/runner/model-route.js");
const { CONFORMANCE_TIMING } = await import("../dist/runner/conformance/harness.js");

const SEAL_KEY = Buffer.alloc(32, 7);
// Dummy key values, built so the source scan reads no literal credential.
const OPENAI_SAVED = `not-a-secret-${"openai-saved"}`;
const ANTHROPIC_SAVED = `not-a-secret-${"anthropic-saved"}`;
const MONID_SAVED = `not-a-secret-${"monid-saved"}`;
const GATEWAY_SAVED = `not-a-secret-${"gateway-saved"}`;

/** A run's process that writes what its pipe of keys carries (fd 3, NAME=VALUE pairs each ended by a NUL) to the file its
 *  one argument names, then exits: the runner's claim then ends, failed, as for any process gone before its loop ended. */
const DUMP = `const fs = require("node:fs"); const net = require("node:net"); const parts = []; const pipe = new net.Socket({ fd: 3, readable: true, writable: false }); pipe.on("data", (part) => parts.push(part)); pipe.on("end", () => { fs.writeFileSync(process.argv.at(-1), Buffer.concat(parts)); process.exit(0); });`;

/** A run's process that also reads its channel (fd 4: frames of a 4-byte length and a V8-serialized message) until the
 *  runner's loop.start, and writes `{ keys, plane }` as JSON: its key pipe as DUMP has it, and the plane its start's init
 *  hands it (null for none). */
const STARTED = `const fs = require("node:fs"); const net = require("node:net"); const v8 = require("node:v8"); let keys = null; let plane; const done = () => { if (keys === null || plane === undefined) return; fs.writeFileSync(process.argv.at(-1), JSON.stringify({ keys, plane })); process.exit(0); }; const parts = []; const pipe = new net.Socket({ fd: 3, readable: true, writable: false }); pipe.on("data", (part) => parts.push(part)); pipe.on("end", () => { keys = Buffer.concat(parts).toString("utf8"); done(); }); let buf = Buffer.alloc(0); const channel = new net.Socket({ fd: 4, readable: true, writable: true }); channel.on("data", (chunk) => { buf = Buffer.concat([buf, chunk]); while (buf.length >= 4) { const n = buf.readUInt32BE(0); if (buf.length < 4 + n) return; const message = v8.deserialize(buf.subarray(4, 4 + n)); buf = buf.subarray(4 + n); if (message.t === "call" && message.m === "start") { plane = message.a[0].plane ?? null; done(); } } });`;

/** The names a dump holds. */
const namesIn = (bytes) => bytes.toString("utf8").split("\0").filter(Boolean).map((pair) => pair.slice(0, pair.indexOf("=")));

/** The key names the process of a run of `revision` launched on `model` (and `plane`, if given) is handed by its runner,
 *  with `saved` sealed, `gateway`, if given, saved in the console, and the server's tool settings `settings`, if given. */
async function handed(t, { revision, model, plane, saved, env = {}, gateway, settings }, script = DUMP, read = (bytes) => namesIn(bytes)) {
  const { store, dir: data } = await storeOn(t);
  if (settings) await store.settings.put("tool-settings", settings);
  for (const [name, value] of Object.entries(saved)) await putSealedKey(store, SEAL_KEY, name, value);
  if (gateway) await saveGateway({ store, sealKey: SEAL_KEY, env: {}, changed: async () => {} }, gateway);
  await store.agents.create({ id: "agent", name: "Pinned" }, { id: "rev", kind: "agentic", body: { instructions: "Work.", ...revision } });
  await store.runs.create({ id: "run", agentId: "agent", revisionId: "rev" }, { body: launchBody({ input: { content: "Work." }, title: "Work", place: { mode: "runner" }, harness: "pi", model, ...(plane ? { plane } : {}) }) });
  const out = join(data, "handed.bin");
  const deps = { store, data, sealKey: SEAL_KEY, env, computerForClaim: async () => { throw new Error("no computer here"); } };
  const loop = childLoops({ deps, isolation: { kind: "process", why: "a test's runner" }, log: () => {}, argv: [process.execPath, "-e", script, out] })({
    signal: new AbortController().signal, journal: (claim) => store.journal(claim), flush: async () => {}, delivered: Promise.resolve(), redact: heldRedactor((text) => text),
  });
  const claim = await store.claim("run", "fixture", { leaseMs: 60_000 });
  await assert.rejects(loop.start(claim), /ended with its run/);
  return read(readFileSync(out));
}
const modelKeysOf = (names) => names.filter((name) => MODEL_KEY_NAMES.includes(name)).sort();

test("a run's process is handed its pinned model's key alone, never the key of the host's default now; a --faux start's, no model key", { timeout: 60_000 }, async (t) => {
  // Started with OpenAI's key alone saved, it pinned OpenAI's model; Anthropic's, saved since, is the host's default now
  // (the first of anthropic, openai, openrouter), and its revision names no model.
  const moved = await handed(t, { revision: { tools: ["monid:faux/person/enrich"] }, model: { provider: "openai", modelId: "gpt-6.1-sol" }, saved: { OPENAI_API_KEY: OPENAI_SAVED, ANTHROPIC_API_KEY: ANTHROPIC_SAVED, MONID_API_KEY: MONID_SAVED } });
  assert.ok(moved.includes("MONID_API_KEY"), `its tool's key is on its pipe: ${moved}`);
  assert.deepEqual(modelKeysOf(moved), ["OPENAI_API_KEY"], "its pinned model's key alone, never the host's default's now");
  // A --faux start on a runner in faux mode: pinned to the faux model, which sends no key, though its revision names
  // Anthropic's model and every key is saved: its tool's key alone.
  const faux = await handed(t, { revision: { model: "anthropic/claude-sonnet-5-5", tools: ["monid:faux/person/enrich"] }, model: { provider: "faux", modelId: "faux-1" }, saved: { ANTHROPIC_API_KEY: ANTHROPIC_SAVED, OPENAI_API_KEY: OPENAI_SAVED, MONID_API_KEY: MONID_SAVED }, env: { [FAUX_ENV]: "1" } });
  assert.ok(faux.includes("MONID_API_KEY"), `its tool's key is on its pipe: ${faux}`);
  assert.deepEqual(modelKeysOf(faux), [], "a --faux start's process holds a model key, which the faux model never sends");
  assert.deepEqual(faux, ["MONID_API_KEY"], "a --faux start's process holds its tool's key alone");
});

test("no run on a --faux runner, nor a faux-pinned launch on any runner, is handed a gateway key, set where the runner starts or saved in the console; a run pinned to a provider's model off faux is", { timeout: 60_000 }, async (t) => {
  const revision = { model: "anthropic/claude-sonnet-5-5", tools: [] };
  const faux = { provider: "faux", modelId: "faux-1" };
  const anthropic = { provider: "anthropic", modelId: "claude-sonnet-5-5" };
  const onEnv = { saved: { AGENT_MODEL_API_KEY: GATEWAY_SAVED }, env: { AGENT_MODEL_BASE_URL: "https://gateway.example.com/v1" } };
  const onSaved = { saved: {}, gateway: { base_url: "https://gateway.example.com/v1", api_key: GATEWAY_SAVED, models: { default: "m-1" } }, env: {} };
  for (const [where, on] of [["the runner's gateway", onEnv], ["the saved gateway", onSaved]]) {
    const inFaux = { ...on, env: { ...on.env, [FAUX_ENV]: "1" } };
    assert.deepEqual(await handed(t, { revision, model: anthropic, ...on }), ["AGENT_MODEL_API_KEY"], `a provider's model on ${where}, off faux: its key`);
    assert.deepEqual(await handed(t, { revision, model: anthropic, ...inFaux }), [], `a run on a --faux runner holds ${where}'s key, which the faux model never sends`);
    assert.deepEqual(await handed(t, { revision, model: faux, ...inFaux }), [], `a --faux start's process holds ${where}'s key, which the faux model never sends`);
    // A faux-pinned launch claimed by a runner on the same store that is not in faux mode: still no key.
    assert.deepEqual(await handed(t, { revision, model: faux, ...on }), [], `a faux-pinned launch on a runner not in faux mode holds ${where}'s key`);
  }
});

test("a run kept on Parallel for web_search, claimed after the server is set to native: its process is handed no Parallel key, which its capped plane never uses; with no ceiling it is", { timeout: 60_000 }, async (t) => {
  const PARALLEL_SAVED = `not-a-secret-${"parallel-saved"}`;
  const run = { revision: { tools: ["web_search"], toolSettings: { web_search: { provider: "parallel" } } }, model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, plane: { web_search: "parallel" }, saved: { ANTHROPIC_API_KEY: ANTHROPIC_SAVED, PARALLEL_API_KEY: PARALLEL_SAVED } };
  assert.ok((await handed(t, run)).includes("PARALLEL_API_KEY"), "kept on Parallel with no ceiling: its key");
  const capped = await handed(t, { ...run, settings: { web_search: { provider: "native" } } });
  assert.ok(!capped.includes("PARALLEL_API_KEY"), `under the server's native: no Parallel key on its pipe: ${capped}`);
  assert.deepEqual(modelKeysOf(capped), ["ANTHROPIC_API_KEY"], "its pinned model's key still");
});

test("a run's process is told the plane its runner capped and chose its keys by, so a setting changed after the runner's read can't run its tools on a key it was not handed", { timeout: 60_000 }, async (t) => {
  const PARALLEL_SAVED = `not-a-secret-${"parallel-saved"}`;
  const run = { revision: { tools: ["web_search"], toolSettings: { web_search: { provider: "parallel" } } }, model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, plane: { web_search: "parallel" }, saved: { ANTHROPIC_API_KEY: ANTHROPIC_SAVED, PARALLEL_API_KEY: PARALLEL_SAVED } };
  const started = (bytes) => {
    const got = JSON.parse(bytes.toString("utf8"));
    return { names: namesIn(Buffer.from(got.keys)), plane: got.plane };
  };
  const capped = await handed(t, { ...run, settings: { web_search: { provider: "native" } } }, STARTED, started);
  assert.ok(!capped.names.includes("PARALLEL_API_KEY"), `under native: no Parallel key: ${capped.names}`);
  assert.equal(capped.plane?.web_search, "native", `its start says the plane its keys were chosen by: ${JSON.stringify(capped.plane)}`);
  const kept = await handed(t, run, STARTED, started);
  assert.ok(kept.names.includes("PARALLEL_API_KEY"), "no ceiling: its key");
  assert.equal(kept.plane?.web_search, "parallel", "and the plane it was kept on");
});

const until = async (done, what, ms = 40_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await done();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${ms} ms: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

// Anthropic's key saved alone (none where the runner starts), the run pinned to Anthropic's model at its start; the
// host's default now OpenAI's, whose key is saved too. Its requests go to a faux gateway on loopback.
for (const where of ["runner", "process"]) {
  test(`pi, ${where === "runner" ? "in the runner" : "in a process of its own"}: a run pinned to a model whose key is saved alone runs on it, the saved key on each request`, { timeout: 90_000 }, async (t) => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "pinned-saved-key-"));
    const server = await openSqliteStore({ dataDir: dir, role: "server" });
    const store = await openSqliteStore({ dataDir: dir, role: "runner" });
    const gw = await startFauxGateway({ text: "done" });
    let runner;
    t.after(async () => {
      await runner?.close().catch(() => {});
      await gw.close();
      await store.close().catch(() => {});
      await server.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    });
    await server.agents.create({ id: "agent-1", name: "Pinned" }, { id: "rev-1", kind: "agentic", body: { instructions: "Say done.", tools: ["read"] } });
    await putSealedKey(server, SEAL_KEY, "ANTHROPIC_API_KEY", ANTHROPIC_SAVED);
    await putSealedKey(server, SEAL_KEY, "OPENAI_API_KEY", OPENAI_SAVED);
    const env = { PATH: process.env.PATH, TMPDIR: dir, ANTHROPIC_BASE_URL: gw.url, AGENT_MODEL: "openai/gpt-6-luna", NODE_TEST_CONTEXT: process.env.NODE_TEST_CONTEXT ?? "1" };
    const launch = { input: { content: "Say done." }, title: "t", place: { mode: "runner" }, harness: "pi", model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } };
    await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: launch });
    await server.flush?.();
    const deps = { env, data: dir, journal: (claim) => store.journal(claim), store, sealKey: SEAL_KEY, routeOf, computerForClaim: async () => ({ release: async () => {} }), log: () => {} };
    const createLoop = where === "process"
      ? childLoops({ deps, isolation: { kind: "process", why: "a test's runner" }, log: deps.log })
      : createDispatchLoop({ launchOf: (runId) => store.runs.launch(runId), resolve: (name, given) => (name === "pi" ? createAdapterLoop((claim, run) => adapterRunSpecFromLaunch(given, run, deps, claim)) : undefined) });
    runner = startRunner({ store, name: "runner-a", ...CONFORMANCE_TIMING, leaseMs: 60_000, stopMarginMs: 5_000, createLoop });
    const row = await until(async () => {
      const now = await server.runs.get("run-1");
      return ["ended", "failed", "stopped"].includes(now.state) && now.runner === null && now;
    }, "the run's end", 60_000);
    assert.equal(row.state, "ended", JSON.stringify(row));
    const asked = gw.requests.filter((request) => request.path === "/v1/messages");
    assert.ok(asked.length > 0, `the run's model was asked: ${JSON.stringify(gw.requests.map((r) => r.path))}`);
    assert.deepEqual([...new Set(asked.map((request) => request.headers["x-api-key"]))], [ANTHROPIC_SAVED], "each request on the saved key");
    assert.deepEqual(gw.requests.filter((request) => request.path !== "/v1/messages").map((request) => request.path), [], "nothing on the host's default's route");
  });
}
