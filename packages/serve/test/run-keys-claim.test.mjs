// A claim opens the run's own tool keys from its launch's sealed column (store/seal.ts) and lays each one its revision's
// tools read over the environment its tools run under, over a key the server holds by the same name; one its revision
// does not read is never laid. The keys travel with the run's launch secrets and never with a replay's MCP credentials.
// A launch sealed under another key refuses the claim in words. Keys are made at run time, never real.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { openSqliteStore } = await import("../dist/store/sqlite/store.js");
const { claimSecrets } = await import("../dist/runner/claim-secrets.js");
const { openRunLaunch, sealRunLaunch, sealRunMcpAuth } = await import("../dist/store/seal.js");
const { putSealedKey } = await import("../dist/server-keys.js");
const { declaredKeys, keysOfTools } = await import("../dist/run-keys.js");

const KEY = randomBytes(32);
const RUN = "run_keys_claim";
const newKey = (label) => ["not-a-secret", label, randomBytes(6).toString("hex")].join("-");
const rev = (tools) => ({ kind: "agentic", body: { tools } });
const WEB_ON_PARALLEL = { plane: { web_search: "parallel", web_fetch: "parallel" } };

/** A store holding `saved` as Settings saves keys, whose runs' launches are `launches` (run id to sealed bytes). */
async function storeWith(t, saved = {}, launches = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "run-keys-claim-"));
  const store = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => { await store.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  for (const [name, value] of Object.entries(saved)) await putSealedKey(store, KEY, name, value);
  return { sealedKeys: store.sealedKeys, runs: { launch: async (runId) => ({ body: "{}", sealed: launches[runId] ?? null }) } };
}

test("the claim lays the run's own key over the environment its tools run under: the key its revision reads, over the server's by the same name", async (t) => {
  const carried = newKey("carried");
  const store = await storeWith(t, { PARALLEL_API_KEY: newKey("saved") }, { [RUN]: sealRunLaunch(KEY, RUN, { keys: { PARALLEL_API_KEY: carried } }) });
  const env = await claimSecrets({ store, sealKey: KEY, env: { MONID_API_KEY: newKey("env") } }, rev(["web_search"]), WEB_ON_PARALLEL, RUN);
  assert.equal(env.PARALLEL_API_KEY, carried, "the run's key, over the one saved here");
  assert.equal(env.MONID_API_KEY, undefined, "a key the run's tools do not read is in neither");
});

test("a run key its revision's tools do not read is never laid; a claim given no run id lays none", async (t) => {
  const carried = newKey("carried");
  const store = await storeWith(t, {}, { [RUN]: sealRunLaunch(KEY, RUN, { keys: { MONID_API_KEY: carried, PARALLEL_API_KEY: carried } }) });
  const web = await claimSecrets({ store, sealKey: KEY, env: {} }, rev(["web_search"]), WEB_ON_PARALLEL, RUN);
  assert.equal(web.MONID_API_KEY, undefined, "a web run never gets the monid key it carried");
  assert.equal(web.PARALLEL_API_KEY, carried);
  const none = await claimSecrets({ store, sealKey: KEY, env: {} }, rev(["web_search"]), WEB_ON_PARALLEL);
  assert.equal(none.PARALLEL_API_KEY, undefined, "no run id, no run keys");
});

test("a launch sealed under another key refuses the claim in words", async (t) => {
  const store = await storeWith(t, {}, { [RUN]: sealRunLaunch(randomBytes(32), RUN, { keys: { PARALLEL_API_KEY: newKey("other") } }) });
  await assert.rejects(claimSecrets({ store, sealKey: KEY, env: {} }, rev(["web_search"]), WEB_ON_PARALLEL, RUN), /This run's launch secrets do not open with this runner's seal key: its keys are not sent\./);
});

test("run keys are sealed with the launch secrets and opened back; a replay's MCP credentials never carry them", () => {
  const carried = newKey("carried");
  const sealed = sealRunLaunch(KEY, RUN, { keys: { PARALLEL_API_KEY: carried } });
  assert.ok(sealed && !Buffer.from(sealed).includes(carried), "sealed, never plain");
  assert.deepEqual(openRunLaunch(KEY, RUN, sealed), { keys: { PARALLEL_API_KEY: carried } });
  assert.equal(openRunLaunch(KEY, "another_run", sealed), undefined, "bound to its run");
  assert.equal(sealRunLaunch(KEY, RUN, { keys: {} }), null, "no keys, nothing sealed");
  assert.deepEqual(openRunLaunch(KEY, RUN, sealRunMcpAuth(KEY, RUN, {})), { mcp: {} });
});

test("the keys a revision declares: each tool key field its tools read, and its template's tool keys", async () => {
  assert.deepEqual(keysOfTools(["web_search", "read"]), ["PARALLEL_API_KEY"]);
  assert.deepEqual(keysOfTools(["monid:faux/person/enrich"]), ["MONID_API_KEY"]);
  assert.deepEqual(keysOfTools(["browser"]).sort(), ["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY"]);
  assert.deepEqual(keysOfTools(["read", "bash"]), []);
  assert.deepEqual(await declaredKeys({ kind: "agentic", body: { tools: ["read"] }, package: { id: "t", version: "1.0.0", sha: null, secrets: ["MONID_API_KEY", "OPENROUTER_API_KEY"] } }), ["MONID_API_KEY"], "a template's tool key, never its model key");
  assert.deepEqual(await declaredKeys({ kind: "agentic", body: { tools: ["web_search"] }, package: null }), ["PARALLEL_API_KEY"]);
});

const { carryTo, cutDeep, heldRedactor, secretRedactor } = await import("../dist/runner/redact.js");
const { underClaimed } = await import("../dist/runner/claim-secrets.js");
const { withCarried } = await import("../dist/run-keys.js");

test("a run's journal cut is of its own keys alone, names included, and goes with its claim", () => {
  const redact = heldRedactor((text) => text);
  const mine = newKey("mine");
  const theirs = newKey("theirs");
  carryTo(redact, "run_mine")([mine]);
  carryTo(redact, "run_theirs")([theirs]);
  assert.equal(redact.carried("run_none"), undefined, "a run that carried nothing writes uncut");
  const written = JSON.stringify(cutDeep({ [mine]: { said: `the key is ${mine}` }, list: [mine], other: theirs }, redact.carried("run_mine"), true));
  assert.ok(!written.includes(mine), "the run's key, as a value and as a JSON name, is cut as written");
  assert.ok(written.includes(theirs), "another run's key is not in this run's cut");
  redact.dropCarried("run_mine");
  assert.equal(redact.carried("run_mine"), undefined, "a claim let go takes its keys with it");
  assert.ok(redact.carried("run_theirs"), "the other run's stay");
});

test("a carried key all of digits, written as a JSON number, is cut too: its digits in the number, or the same number written otherwise", () => {
  const redact = heldRedactor((text) => text);
  // Two keys of digits alone: one the number shows as written, one whose leading zero a number drops.
  const plain = "4111111111111111";
  const padded = "0522222222222222";
  carryTo(redact, "run_digits")([plain, padded]);
  const cut = redact.carried("run_digits");
  const out = cutDeep({ args: { pin: Number(plain), big: BigInt(plain), list: [Number(plain)], zero: Number(padded) }, count: 3 }, cut, true);
  assert.deepEqual(out, { args: { pin: "[redacted]", big: "[redacted]", list: ["[redacted]"], zero: "[redacted]" }, count: 3 }, "each number showing a carried key is cut, another number kept");
});

test("two names cut to one are both kept, the later numbered", () => {
  const one = newKey("one");
  const two = newKey("two");
  const cut = secretRedactor([one, two]);
  const out = cutDeep({ [one]: 1, [two]: 2 }, cut, true);
  assert.deepEqual(Object.values(out).sort(), [1, 2], "no value is lost to a collision");
  assert.ok(!JSON.stringify(out).includes(one) && !JSON.stringify(out).includes(two));
  const map = cutDeep(new Map([[one, 1], [two, 2]]), cut, true);
  assert.equal(map.size, 2);
  assert.ok(![...map.keys()].some((name) => name.includes(one) || name.includes(two)));
  assert.deepEqual(Object.keys(cutDeep({ [one]: 1 }, cut)), [one], "without names, names are left as they are");
});

test("a learned workflow's decision key is laid under the claim's own: the run's key stays", () => {
  const carried = newKey("carried");
  const env = { PARALLEL_API_KEY: carried };
  underClaimed(env, { PARALLEL_API_KEY: newKey("server"), JEV_API_KEY: "jev-key" });
  assert.equal(env.PARALLEL_API_KEY, carried, "the run's own key, never the server's over it");
  assert.equal(env.JEV_API_KEY, "jev-key", "a name the claim did not lay is laid");
});

test("a key the server holds empty counts as carried when the run brings it", () => {
  const tag = Symbol("kept");
  const env = Object.defineProperty({ [tag]: 1 }, "PARALLEL_API_KEY", { value: "", enumerable: false, writable: false, configurable: false });
  const checked = withCarried(env, ["PARALLEL_API_KEY"]);
  assert.ok(checked.PARALLEL_API_KEY, "an empty fixed key is the run's to fill");
  assert.equal(checked[tag], 1, "every other property is kept");
  assert.equal(env.PARALLEL_API_KEY, "", "the server's own is left as it is");
});
