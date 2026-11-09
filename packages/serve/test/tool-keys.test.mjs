// Tool keys saved by name through /v2/settings/tool-keys: kept in the data directory as ciphertext alone, under a seal
// key the launcher hands the server from outside it. GET names each field and where it is set, never a value. A value
// that does not open (no seal key, another one, a damaged file) is asked for again, said once in the log, and never
// stops the server; there is no clear fallback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { unseal } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { secret } from "../dist/secrets.js";
import { readingOf } from "../dist/server.js";
import { rowUnlocks, TOOL_KEYS, unlockedBy } from "../dist/tool-keys.js";
import { schemaProblems } from "./schema-support.mjs";
import { agent, call, harnessData, client, cookieOf, FAUX, follow, printed, scratch, serve, withEnv } from "./support.mjs";

const LAUNCHER = new URL("../launcher/agentrun-serve", import.meta.url).pathname;
const FAUX_BROWSER = new URL("./fixtures/faux-browser.mjs", import.meta.url).pathname;
const KEYS = ["PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "KERNEL_API_KEY", "TYPESAFE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "AGENTRUN_SEAL_KEY"];
const sealKey = () => randomBytes(32).toString("base64");
/** A throwaway value: none is a real key. */
const made = () => `not-a-secret-${randomBytes(12).toString("hex")}`;
/** Each form a value could plausibly leak in: as text, base64, base64url and hex, and its random part's first 8. */
const formsOf = (value) => [value, ...["base64", "base64url", "hex"].map((code) => Buffer.from(value).toString(code)), value.slice(13, 21)];
/** A seal key's forms: its base64 text, its bytes, and those as hex and base64url. */
const keyForms = (key) => [key, Buffer.from(key, "base64"), ...["hex", "base64url"].map((code) => Buffer.from(key, "base64").toString(code))];
const holdsNone = (bytes, forms, where) => { for (const form of forms) assert.ok(!Buffer.from(bytes).includes(form), `${where} holds a key (${String(form).length} long)`); };
const MiB = 2 ** 20;
/** The settings a harness's offer is made from, cleared where a test sets its own. */
const HARNESS_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "CODEX_BIN", "AGENTRUN_SERVE_CODEX_STANDIN", "AGENTRUN_CLAUDE_AGENT_EXECUTABLE"];
/** This process's container limit read as `mib` until the test ends (host.ts' hostMemory reads it), as admission.test.mjs
 *  stands one in: whether a harness's one run fits is the host's memory, so each test here names it. */
function withMemory(t, mib) {
  const was = process.constrainedMemory;
  process.constrainedMemory = () => mib * MiB;
  t.after(() => void (process.constrainedMemory = was));
}
/** Room for one run of every harness (claude-agent's, the largest, needs 416 MiB with the server's own). */
const ROOMY_MIB = 4096;
/** A codex stand-in (no binary check, nothing is run), as AGENTRUN_SERVE_CODEX_STANDIN takes it. */
async function codexStandIn(t) {
  const file = join(await scratch(t), "codex");
  writeFileSync(file, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return JSON.stringify({ command: file });
}
/** A model row's harnesses with every harness installed, room for each, and no model key: its own (model.ts' MODEL_KEYS). */
const OWN = Object.fromEntries(TOOL_KEYS.filter((row) => row.kind === "model").map((row) => [row.id, [...row.harnesses]]));
const fieldsOf = (view) => Object.fromEntries(view.keys.flatMap((key) => key.fields.map(({ name, ...field }) => [name, field])));
const STORED = { set: true, source: "stored" };
const UNSET = { set: false, source: null };
const AGAIN = { set: false, source: null, stored_unreadable: true };
/** GET's answer meets the schema the served document gives it. */
async function meetsDocument(api, view) {
  const doc = (await api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(doc, doc.paths["/settings/tool-keys"].get.responses["200"].content["application/json"].schema, view), [], JSON.stringify(view));
}

test("a tool key saved then removed in Settings: the refusal names Settings → Tool keys first, then the variable, for Monid and for Parallel; the structured fields are unchanged", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey(), AGENTRUN_SERVE_CODEX_STANDIN: await codexStandIn(t) }, [...KEYS, ...HARNESS_VARS]);
  withMemory(t, ROOMY_MIB);
  const { api } = await serve(t);
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: made() } })).status, 204);
  assert.equal((await api("DELETE", "/settings/tool-keys/monid")).status, 204);
  const monid = "monid.discover needs a Monid key: save one in Settings → Tool keys (or set MONID_API_KEY where the server starts)";
  const saved = await api("POST", "/agents", agent("finder", { tools: ["monid.discover"] }));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.warnings.map((w) => w.message), [`The tool ${monid}.`], "the save's warning");
  const run = await api("POST", "/agents/finder/runs", { input: { content: "hi" } });
  assert.equal(run.status, 409, JSON.stringify(run.body));
  assert.ok(run.body.error.message.includes(monid), run.body.error.message);
  assert.ok(!/environment does not set/.test(run.body.error.message), run.body.error.message);
  assert.deepEqual(run.body.error.details.missing, { "monid.discover": ["MONID_API_KEY"] }, "the structured fields are unchanged");
  assert.equal((await api("PUT", "/settings/tools", { web_search: { provider: "parallel" } })).status, 200);
  assert.equal((await api("POST", "/agents", agent("searcher", { tools: ["web_search"] }))).status, 201);
  const search = await api("POST", "/agents/searcher/runs", { input: { content: "hi" } });
  assert.equal(search.status, 409, JSON.stringify(search.body));
  assert.ok(search.body.error.message.includes("web_search does not run here on pi: parallel is picked, and it needs a Parallel key: save one in Settings → Tool keys (or set PARALLEL_API_KEY where the server starts)"), search.body.error.message);
});

test("a key saved by name is kept sealed: GET says which fields are set and from where, never a value; PUT merges by field, DELETE forgets; the file is 0600 and holds no value", async (t) => {
  // Under a permissive umask, so the mode seen is the one the write asks for, not what the umask leaves of it.
  const umask = process.umask(0o022);
  t.after(() => process.umask(umask));
  const key = sealKey();
  withEnv(t, { AGENTRUN_SEAL_KEY: key, AGENTRUN_SERVE_CODEX_STANDIN: await codexStandIn(t) }, [...KEYS, ...HARNESS_VARS]);
  withMemory(t, ROOMY_MIB);
  const { api, data } = await serve(t);
  const values = { PARALLEL_API_KEY: made(), BROWSERBASE_API_KEY: made(), BROWSERBASE_PROJECT_ID: made() };
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: values.PARALLEL_API_KEY } })).status, 204);
  assert.equal((await api("PUT", "/settings/tool-keys/browserbase", { values: { BROWSERBASE_API_KEY: values.BROWSERBASE_API_KEY } })).status, 204);
  assert.equal((await api("PUT", "/settings/tool-keys/browserbase", { values: { BROWSERBASE_PROJECT_ID: values.BROWSERBASE_PROJECT_ID } })).status, 204, "one field of two, the other kept");
  const listed = await api("GET", "/settings/tool-keys");
  assert.equal(listed.status, 200);
  assert.deepEqual(fieldsOf(listed.body), { PARALLEL_API_KEY: STORED, MONID_API_KEY: UNSET, BROWSERBASE_API_KEY: STORED, BROWSERBASE_PROJECT_ID: STORED, KERNEL_API_KEY: UNSET, TYPESAFE_API_KEY: UNSET, ANTHROPIC_API_KEY: UNSET, OPENAI_API_KEY: UNSET, OPENROUTER_API_KEY: UNSET });
  // A model key's harnesses: pi and its provider's own, every one installed and with room here, none saved yet.
  assert.deepEqual(listed.body.keys.map((k) => [k.id, k.kind, k.unlocks, k.harnesses]), [
    ["parallel", "tool", ["web_fetch", "web_search", "decisions.parallel"], ["pi", "claude-agent", "codex", "opencode"]],
    ["monid", "tool", ["monid.discover", "monid.inspect", "monid.run"], ["pi", "claude-agent", "codex", "opencode"]],
    ["browserbase", "tool", ["browser"], ["pi"]],
    ["kernel", "tool", ["browser"], ["pi"]],
    ["typesafe", "tool", ["decisions.jev"], []],
    ["anthropic", "model", [], ["pi", "claude-agent"]],
    ["openai", "model", [], ["pi", "codex", "opencode"]],
    ["openrouter", "model", [], ["pi", "claude-agent", "codex", "opencode"]],
  ], "only what this server binds: web_fetch and web_search on every harness; the monid tools on every harness, as capabilities run them");
  assert.equal(listed.body.reenter, null);
  await meetsDocument(api, listed.body);
  const file = join(data, "tool-keys.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const value of Object.values(values)) {
    holdsNone(JSON.stringify(listed.body), formsOf(value), "GET's answer");
    holdsNone(readFileSync(file), formsOf(value), "tool-keys.json");
  }
  // The file's own reading: each value opens under the seal key bound to its own name and this format, no other.
  const kept = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(kept.fields).sort(), Object.keys(values).sort());
  const sealed = Buffer.from(kept.fields.PARALLEL_API_KEY.sealed, "base64");
  assert.equal(unseal(Buffer.from(key, "base64"), sealed, "tool-keys/1|PARALLEL_API_KEY").toString(), values.PARALLEL_API_KEY);
  assert.throws(() => unseal(Buffer.from(key, "base64"), sealed, "tool-keys/1|MONID_API_KEY"));
  holdsNone(readFileSync(file), keyForms(key), "tool-keys.json");
  assert.equal((await api("DELETE", "/settings/tool-keys/browserbase")).status, 204);
  assert.deepEqual(fieldsOf((await api("GET", "/settings/tool-keys")).body), { PARALLEL_API_KEY: STORED, MONID_API_KEY: UNSET, BROWSERBASE_API_KEY: UNSET, BROWSERBASE_PROJECT_ID: UNSET, KERNEL_API_KEY: UNSET, TYPESAFE_API_KEY: UNSET, ANTHROPIC_API_KEY: UNSET, OPENAI_API_KEY: UNSET, OPENROUTER_API_KEY: UNSET });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).fields), ["PARALLEL_API_KEY"]);
});

test("each key unlocks only what capabilities bind, a tool or a decision provider, and runs on the union of those tools' harnesses; a name bound later shows with no edit to the key table", async (t) => {
  for (const [label, env] of [["no key set", {}], ["every key set", { PARALLEL_API_KEY: made(), MONID_API_KEY: made(), BROWSERBASE_API_KEY: made(), BROWSERBASE_PROJECT_ID: made() }]]) {
    await t.test(label, async (st) => {
      withEnv(st, { AGENTRUN_SEAL_KEY: sealKey(), AGENTRUN_SERVE_CODEX_STANDIN: await codexStandIn(st), ...env }, [...KEYS, ...HARNESS_VARS]);
      withMemory(st, ROOMY_MIB);
      const { api } = await serve(st);
      const caps = (await api("GET", "/capabilities")).body;
      const view = (await api("GET", "/settings/tool-keys")).body;
      const tools = new Map(caps.tools.map((tool) => [tool.name, tool]));
      const bound = new Set([...tools.keys(), ...caps.workflows.decisions.providers.map((provider) => `decisions.${provider.id}`)]);
      assert.deepEqual(view.keys.map((key) => key.id), TOOL_KEYS.map((row) => row.id), "every key lists, one that unlocks nothing too");
      for (const [i, key] of view.keys.entries()) {
        assert.deepEqual(key.unlocks, TOOL_KEYS[i].unlocks.filter((name) => bound.has(name)), `${key.id}: its names capabilities bind, and only those`);
        // A model key unlocks no tool: its harnesses are pi and its provider's own, each installed and with room here.
        const run = new Set(TOOL_KEYS[i].kind === "tool" ? key.unlocks.flatMap((name) => tools.get(name)?.harnesses ?? []) : OWN[key.id]);
        assert.deepEqual([...key.harnesses].sort(), [...run].sort(), `${key.id}: the harnesses of the tools it unlocks, or that run on its model key`);
      }
      for (const tool of caps.tools) if (tool.key !== undefined) assert.ok(view.keys.find((key) => key.id === tool.key)?.unlocks.includes(tool.name), `${tool.name} names the key ${tool.key}, which unlocks it`);
      await meetsDocument(api, view);
    });
  }
  // Bound later: once capabilities list web_search, the key table's own name shows it.
  const later = [{ name: "web_fetch", harnesses: ["pi", "claude-agent", "codex"] }, { name: "web_search", harnesses: ["pi"] }];
  assert.deepEqual(unlockedBy(TOOL_KEYS[0].unlocks, later, [{ id: "jev" }]), { unlocks: ["web_fetch", "web_search"], harnesses: ["pi", "claude-agent", "codex"] }, "no parallel provider, no decisions.parallel");
  // A key of another kind (a model's; none yet) unlocks no tool, and is for the harnesses this server offers.
  const offers = [{ id: "pi", available: true }, { id: "claude-agent", available: true }, { id: "codex", available: false }];
  assert.deepEqual(rowUnlocks({ kind: "model", unlocks: [] }, later, [], offers), { unlocks: [], harnesses: ["pi", "claude-agent"] });
  assert.deepEqual(rowUnlocks(TOOL_KEYS[0], later, [{ id: "jev" }], offers), unlockedBy(TOOL_KEYS[0].unlocks, later, [{ id: "jev" }]), "a tool row, as before");
  // A harness unavailable only for want of a model key (its offer's `keys`) is the row's when its key is among them.
  const keyless = [{ id: "pi", available: true }, { id: "claude-agent", available: false, keys: ["ANTHROPIC_API_KEY"] }, { id: "codex", available: false, keys: ["OPENAI_API_KEY", "OPENROUTER_API_KEY"] }];
  const model = (id) => TOOL_KEYS.find((row) => row.id === id);
  assert.deepEqual(rowUnlocks(model("openrouter"), later, [], keyless).harnesses, ["pi", "codex"], "claude-agent needs Anthropic's own key here: OpenRouter's does not reach it");
  assert.deepEqual(rowUnlocks(model("anthropic"), later, [], keyless).harnesses, ["pi", "claude-agent"]);
  assert.deepEqual(rowUnlocks(model("openai"), later, [], keyless).harnesses, ["pi", "codex"]);
  assert.deepEqual(rowUnlocks(model("openrouter"), later, [], [{ id: "pi", available: true }, { id: "claude-agent", available: false }, { id: "codex", available: false }]).harnesses, ["pi"], "unavailable for another reason (not installed): left out");
});

test("before any model key is saved, a model key's row names every harness the key runs that this server could run: OpenRouter's all four, Anthropic's pi and claude-agent; one off its pins, one that does not fit and one the key alone does not fix are left out", { timeout: 180_000 }, async (t) => {
  const standIn = await codexStandIn(t);
  // A CLI that is not the pinned build.
  const unpinned = join(await scratch(t), "claude");
  writeFileSync(unpinned, "#!/bin/sh\necho 0.0.1\n", { mode: 0o755 });
  const cases = [
    ["claude-agent installed, codex stood in", ROOMY_MIB, { AGENTRUN_SERVE_CODEX_STANDIN: standIn }, OWN],
    // Claude Code not installed yet installs on first use: the key still runs it.
    ["claude-agent not installed yet", ROOMY_MIB, { AGENTRUN_SERVE_CODEX_STANDIN: standIn }, OWN, false],
    // Claude Code's CLI off its pins: no key runs it.
    ["claude-agent's CLI off its pins", ROOMY_MIB, { AGENTRUN_SERVE_CODEX_STANDIN: standIn }, { anthropic: ["pi"], openai: ["pi", "codex", "opencode"], openrouter: ["pi", "codex", "opencode"] }, { cli: unpinned }],
    // Codex not installed yet installs on first use too; its binary off its pins: no key runs it.
    ["codex not installed yet", ROOMY_MIB, {}, OWN, { codex: false }],
    ["codex's binary off its pins", ROOMY_MIB, {}, { anthropic: ["pi", "claude-agent"], openai: ["pi", "opencode"], openrouter: ["pi", "claude-agent", "opencode"] }, { codexBin: unpinned }],
    // 384 MiB holds the server's 128 and one codex run (192), never a claude-agent run (288) or an opencode run (704): no
    // key would run them.
    ["a host too small for a claude-agent run", 384, { AGENTRUN_SERVE_CODEX_STANDIN: standIn }, { anthropic: ["pi"], openai: ["pi", "codex"], openrouter: ["pi", "codex"] }],
    // An endpoint the host names for claude-agent takes Anthropic's key alone, never OpenRouter's.
    ["claude-agent on the host's endpoint", ROOMY_MIB, { AGENTRUN_SERVE_CODEX_STANDIN: standIn, ANTHROPIC_BASE_URL: "https://gateway.invalid" }, { anthropic: ["pi", "claude-agent"], openai: ["pi", "codex", "opencode"], openrouter: ["pi", "codex", "opencode"] }],
    // An endpoint claude-agent refuses (plain http to another machine): its key alone would not run it.
    ["claude-agent on an endpoint it refuses", ROOMY_MIB, { AGENTRUN_SERVE_CODEX_STANDIN: standIn, ANTHROPIC_BASE_URL: "http://gateway.example" }, { anthropic: ["pi"], openai: ["pi", "codex", "opencode"], openrouter: ["pi", "codex", "opencode"] }],
  ];
  for (const [label, mib, vars, rows, harnesses = true] of cases) {
    await t.test(label, async (st) => {
      withEnv(st, { AGENTRUN_SEAL_KEY: sealKey(), ...vars }, [...KEYS, ...HARNESS_VARS]);
      withMemory(st, mib);
      const { api } = await serve(st, { harnesses });
      const caps = (await api("GET", "/capabilities")).body;
      const offers = Object.fromEntries(caps.harnesses.map((offer) => [offer.id, offer]));
      // No model key here: claude-agent and codex do not run now, whatever is installed.
      assert.deepEqual([offers["claude-agent"].available, offers.codex.available], [false, false], JSON.stringify(caps.harnesses));
      for (const offer of caps.harnesses) assert.equal("keys" in offer, false, "what a key would unlock is the key rows', never served in capabilities");
      const view = (await api("GET", "/settings/tool-keys")).body;
      assert.deepEqual(Object.fromEntries(view.keys.filter((key) => key.kind === "model").map((key) => [key.id, key.harnesses])), rows, JSON.stringify(caps.harnesses.map((offer) => [offer.id, offer.reason ?? null])));
      await meetsDocument(api, view);
    });
  }
});

test("a sealed value moved to another field's name does not open there: it is asked for again as a damaged entry", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, KEYS);
  const { api, data } = await serve(t);
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: made() } })).status, 204);
  const file = join(data, "tool-keys.json");
  const kept = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ v: 1, fields: { MONID_API_KEY: kept.fields.PARALLEL_API_KEY } }));
  const view = (await api("GET", "/settings/tool-keys")).body;
  assert.deepEqual([fieldsOf(view).MONID_API_KEY, fieldsOf(view).PARALLEL_API_KEY], [AGAIN, UNSET]);
  assert.deepEqual(view.reenter, { reason: "file_unreadable", fields: ["MONID_API_KEY"] }, "its key check matches: not another key, a moved value");
});

test("PUT refuses with 422 an unknown key or field, an empty value, a control character, over 1 KiB, or another body field, and keeps nothing; no answer holds the value", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, KEYS);
  const { api, data } = await serve(t);
  const value = made();
  for (const [id, body, field] of [
    ["nope", { values: { PARALLEL_API_KEY: value } }, "key_id"],
    ["parallel", { values: { MONID_API_KEY: value } }, "values.MONID_API_KEY"],
    ["parallel", { values: { PARALLEL_API_KEY: "" } }, "values.PARALLEL_API_KEY"],
    ["parallel", { values: { PARALLEL_API_KEY: 7 } }, "values.PARALLEL_API_KEY"],
    ...["\u0000", "\n", "\t", "\u007f", "\u0085"].map((control) => ["parallel", { values: { PARALLEL_API_KEY: `${value}${control}x` } }, "values.PARALLEL_API_KEY"]),
    ["parallel", { values: { PARALLEL_API_KEY: "k".repeat(1025) } }, "values.PARALLEL_API_KEY"],
    ["parallel", { values: { PARALLEL_API_KEY: "é".repeat(513) } }, "values.PARALLEL_API_KEY"],
    ["parallel", { values: {} }, "values"],
    ["parallel", { values: { PARALLEL_API_KEY: value }, note: "x" }, "note"],
  ]) {
    const res = await api("PUT", `/settings/tool-keys/${id}`, body);
    assert.deepEqual([res.status, res.body.error.code], [422, "input_invalid"], JSON.stringify(body).slice(0, 80));
    assert.ok(res.body.error.fields.some((f) => f.field === field), `${field}: ${JSON.stringify(res.body.error.fields)}`);
    holdsNone(JSON.stringify(res.body), formsOf(value), "a refusal");
  }
  assert.equal((await api("DELETE", "/settings/tool-keys/nope")).status, 422);
  assert.equal(existsSync(join(data, "tool-keys.json")), false, "no refusal wrote anything");
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: "k".repeat(1024) } })).status, 204, "1024 bytes is the most");
});

test("a field the server is started with is the server's: GET says so, PUT and DELETE are 409 key_set_by_server; another field of the same key is the page's", async (t) => {
  const server = { PARALLEL_API_KEY: made(), BROWSERBASE_API_KEY: made() };
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey(), ...server }, KEYS);
  const { api } = await serve(t);
  assert.deepEqual((await api("GET", "/capabilities")).body.features.tool_keys, { routes: true, at_rest: "sealed" });
  const refused = await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: made() } });
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.details], [409, "key_set_by_server", { fields: ["PARALLEL_API_KEY"] }]);
  assert.equal((await api("DELETE", "/settings/tool-keys/parallel")).body.error.code, "key_set_by_server");
  assert.equal((await api("PUT", "/settings/tool-keys/browserbase", { values: { BROWSERBASE_API_KEY: made() } })).status, 409);
  assert.equal((await api("PUT", "/settings/tool-keys/browserbase", { values: { BROWSERBASE_PROJECT_ID: made() } })).status, 204);
  const view = (await api("GET", "/settings/tool-keys")).body;
  assert.deepEqual(fieldsOf(view), { PARALLEL_API_KEY: { set: true, source: "server" }, MONID_API_KEY: UNSET, BROWSERBASE_API_KEY: { set: true, source: "server" }, BROWSERBASE_PROJECT_ID: STORED, KERNEL_API_KEY: UNSET, TYPESAFE_API_KEY: UNSET, ANTHROPIC_API_KEY: UNSET, OPENAI_API_KEY: UNSET, OPENROUTER_API_KEY: UNSET });
  for (const value of Object.values(server)) holdsNone(JSON.stringify(view) + JSON.stringify(refused.body), formsOf(value), "an answer");
  assert.equal((await api("DELETE", "/settings/tool-keys/browserbase")).status, 204, "its stored field goes; the server's stays");
  assert.deepEqual(fieldsOf((await api("GET", "/settings/tool-keys")).body).BROWSERBASE_PROJECT_ID, UNSET);
});

test("with no seal key nothing is kept, never in the clear: PUT is 409 no_sealing_key, nothing is written, and capabilities say unavailable", async (t) => {
  withEnv(t, {}, KEYS);
  const { api, data } = await serve(t);
  assert.deepEqual((await api("GET", "/capabilities")).body.features.tool_keys, { routes: true, at_rest: "unavailable" });
  const refused = await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: made() } });
  assert.deepEqual([refused.status, refused.body.error.code], [409, "no_sealing_key"]);
  assert.equal(existsSync(join(data, "tool-keys.json")), false);
  assert.deepEqual((await api("GET", "/settings/tool-keys")).body.reenter, null);
});

test("values sealed under another key, with no key, or in a damaged file do not open: the server starts, GET asks for them again with why, the log says so once naming the file and no value, and a PUT seals anew", async (t) => {
  withEnv(t, {}, KEYS);
  const data = join(await scratch(t), "agents");
  const file = join(data, "tool-keys.json");
  const lines = [];
  const open = new Set();
  t.after(() => Promise.all([...open].map((server) => server.close())));
  const started = async (key) => {
    if (key === undefined) delete process.env.AGENTRUN_SEAL_KEY;
    else process.env.AGENTRUN_SEAL_KEY = key;
    const server = await startServe({ data, port: 0, faux: FAUX, log: (line) => lines.push(line) });
    open.add(server);
    return { close: () => (open.delete(server), server.close()), api: client(server.baseUrl, server.token), said: () => lines.filter((line) => line.includes("event=tool_keys")) };
  };
  const [first, second] = [sealKey(), sealKey()];
  const values = { PARALLEL_API_KEY: made(), MONID_API_KEY: made() };
  let server = await started(first);
  for (const [id, name] of [["parallel", "PARALLEL_API_KEY"], ["monid", "MONID_API_KEY"]]) assert.equal((await server.api("PUT", `/settings/tool-keys/${id}`, { values: { [name]: values[name] } })).status, 204);
  await server.close();

  server = await started(second);
  const parallel = async () => (await server.api("GET", "/capabilities")).body.workflows.decisions.providers.find((p) => p.id === "parallel").available;
  assert.equal(await parallel(), false, "a value that does not open is absent: no key, never a crash or the ciphertext");
  assert.deepEqual(server.said().map((line) => line.replace(/^at=\S+ /, "")), [`event=tool_keys condition=seal_key_changed file=${file} fields=PARALLEL_API_KEY,MONID_API_KEY`], "said once, at the start");
  const changed = (await server.api("GET", "/settings/tool-keys")).body;
  assert.deepEqual([fieldsOf(changed).PARALLEL_API_KEY, fieldsOf(changed).MONID_API_KEY, changed.reenter], [AGAIN, AGAIN, { reason: "seal_key_changed", fields: ["PARALLEL_API_KEY", "MONID_API_KEY"] }]);
  assert.equal(server.said().length, 1, "not again for the same condition");
  await meetsDocument(server.api, changed);
  assert.equal((await server.api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: values.PARALLEL_API_KEY } })).status, 204);
  assert.equal(await parallel(), true, "sealed anew, it is read at once");
  const resealed = (await server.api("GET", "/settings/tool-keys")).body;
  assert.deepEqual([fieldsOf(resealed).PARALLEL_API_KEY, resealed.reenter], [STORED, { reason: "seal_key_changed", fields: ["MONID_API_KEY"] }], "sealed anew under the current key");
  await server.close();

  server = await started(undefined);
  assert.equal(await parallel(), false, "with no seal key, nothing opens");
  const missing = await server.api("GET", "/settings/tool-keys");
  assert.deepEqual(missing.body.reenter, { reason: "seal_key_missing", fields: ["PARALLEL_API_KEY", "MONID_API_KEY"] });
  assert.equal((await server.api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: values.PARALLEL_API_KEY } })).body.error.code, "no_sealing_key");
  await server.close();

  writeFileSync(file, "{ not json");
  server = await started(second);
  assert.equal((await server.api("GET", "/health")).status, 200, "a damaged file never stops the server");
  assert.deepEqual((await server.api("GET", "/settings/tool-keys")).body.reenter, { reason: "file_unreadable", fields: [] }, "a file that does not read names no field");
  assert.equal((await server.api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: values.PARALLEL_API_KEY } })).status, 204, "a PUT replaces it");
  assert.deepEqual((await server.api("GET", "/settings/tool-keys")).body.reenter, null);
  await server.close();
  assert.deepEqual(server.said().map((line) => /condition=(\S+)/.exec(line)[1]), ["seal_key_changed", "seal_key_changed", "seal_key_missing", "file_unreadable"]);
  for (const forms of [...Object.values(values).map(formsOf), keyForms(first), keyForms(second)]) holdsNone(lines.join("\n"), forms, "the log");
});

test("a key saved is read by name with no restart: capabilities lose the tool's missing names and name its key, and a run of it starts; deleted, it is missing again", { timeout: 60_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, KEYS);
  const { api } = await serve(t, { fauxBrowser: FAUX_BROWSER });
  const values = { BROWSERBASE_API_KEY: made(), BROWSERBASE_PROJECT_ID: made() };
  const browser = async () => {
    const caps = (await api("GET", "/capabilities")).body;
    for (const value of Object.values(values)) holdsNone(JSON.stringify(caps), formsOf(value), "capabilities");
    const { summary: _, blurb: ____, providers: __, resolves, why: ___, ...tool } = caps.tools.find((entry) => entry.name === "browser");
    return { ...tool, resolves: resolves.pi };
  };
  const refused = async () => {
    const res = await api("POST", "/agents/browse/runs", { input: { content: "Browse the example page." } });
    return [res.status, res.body.error?.code, res.body.error?.details?.missing];
  };
  // The browser runs on either vendor's keys (tool-plane.ts): unavailable, its reason names both, and no one list is missing.
  // The plane keeps its own value (a run's meta stores it); only the words a person reads name Settings first.
  const STORED_NO_BROWSER_KEY = "unavailable: no browser key: set or save Browserbase's (BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID) or Kernel's (KERNEL_API_KEY)";
  const reason = "it needs a Browserbase key: save one in Settings → Tool keys (or set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID where the server starts), or a Kernel key: save one in Settings → Tool keys (or set KERNEL_API_KEY where the server starts)";
  const unset = { name: "browser", nodes: true, calls: false, available: false, reason, harnesses: ["pi"], provider: "auto", default_provider: "auto", permission: "allow", default_permission: "allow", permissions: ["allow", "deny"], resolves: STORED_NO_BROWSER_KEY, key: "browserbase" };
  assert.deepEqual(await browser(), unset);
  assert.deepEqual((await api("GET", "/capabilities")).body.tools.filter((tool) => tool.key).map((tool) => [tool.name, tool.key]), [["web_fetch", "parallel"], ["web_search", "parallel"], ["browser", "browserbase"], ["monid.discover", "monid"], ["monid.inspect", "monid"], ["monid.run", "monid"]], "only a tool a key unlocks names one");
  assert.equal((await api("POST", "/agents", { definition: { id: "browse", name: "browse", instructions: "Browse.", tools: ["browser"] } })).status, 201);
  assert.deepEqual(await refused(), [409, "agent_not_runnable", {}]);

  assert.equal((await api("PUT", "/settings/tool-keys/browserbase", { values })).status, 204);
  assert.deepEqual(await browser(), { name: "browser", nodes: true, calls: false, available: true, harnesses: ["pi"], provider: "auto", default_provider: "auto", permission: "allow", default_permission: "allow", permissions: ["allow", "deny"], resolves: "browserbase", key: "browserbase" }, "no restart");
  const started = await api("POST", "/agents/browse/runs", { input: { content: "Browse the example page." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"]);

  assert.equal((await api("DELETE", "/settings/tool-keys/browserbase")).status, 204);
  assert.deepEqual(await browser(), unset, "deleted, missing again");
  assert.deepEqual(await refused(), [409, "agent_not_runnable", {}]);
});

test("a browser key saved by name reaches the run's browser with no restart: its provider gets both fields, saved", { timeout: 60_000, skip: "waits on the runner binding the browser tool (runner/adapter-run-spec.ts bindNonHandTools binds web, monid and learned workflows only)" }, async (t) => {
  const log = join(await scratch(t), "browser.jsonl");
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey(), FAUX_BROWSER_LOG: log }, KEYS);
  const { api } = await serve(t, { fauxBrowser: FAUX_BROWSER });
  const values = { BROWSERBASE_API_KEY: made(), BROWSERBASE_PROJECT_ID: made() };
  assert.equal((await api("POST", "/agents", { definition: { id: "browse", name: "browse", instructions: "Browse.", tools: ["browser"] } })).status, 201);
  assert.equal((await api("PUT", "/settings/tool-keys/browserbase", { values })).status, 204);
  const started = await api("POST", "/agents/browse/runs", { input: { content: "Browse the example page." } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(api, started.body.run_id, ["completed"]);
  // The fake browser's first line says whether each field reached the env its provider gets: set or unset, never a value.
  const [seen] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(seen, { op: "env", BROWSERBASE_API_KEY: "set", BROWSERBASE_PROJECT_ID: "set" }, "the run's browser got both, saved");
});

test("the page's owner saves and forgets a key with the session cookie from the page's own origin; from another origin the cookie is no credential", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, KEYS);
  const server = await serve(t, { accounts: true, openSetup: true });
  const own = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { "content-type": "application/json", origin: own }, body: { password: "not-a-secret" } });
  const cookie = cookieOf(setup);
  const write = (method, origin) => call(server.port, { method, path: "/v2/settings/tool-keys/monid", headers: { cookie, "content-type": "application/json", origin }, ...(method === "PUT" ? { body: { values: { MONID_API_KEY: made() } } } : {}) });
  const monid = async () => fieldsOf((await call(server.port, { path: "/v2/settings/tool-keys", headers: { cookie } })).json).MONID_API_KEY;
  assert.equal((await write("PUT", "https://evil.example")).status, 401);
  assert.deepEqual(await monid(), UNSET);
  assert.equal((await write("PUT", own)).status, 204);
  assert.deepEqual(await monid(), STORED);
  assert.equal((await write("DELETE", "https://evil.example")).status, 401);
  assert.equal((await write("DELETE", own)).status, 204);
  assert.deepEqual(await monid(), UNSET);
});

/** The server under its launcher, with the test's own config directory: no key but its token in its environment. */
async function launched(t, data, config, token) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !KEYS.includes(name)));
  const child = spawn(LAUNCHER, ["--data", data, "--port", "0", "--faux", FAUX], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...env, XDG_CONFIG_HOME: config, AGENTRUN_TOKEN: token } });
  // Signalled only while it lives: once it has exited, its group id may be another process's (PIDs wrap in minutes).
  let alive = true;
  const exited = new Promise((resolve) => child.once("exit", (code) => ((alive = false), resolve(code))));
  const stop = async () => {
    try {
      if (alive) process.kill(-child.pid, "SIGTERM");
    } catch {}
    await exited;
  };
  t.after(stop);
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  await printed(child, /^AGENTRUN_BASE_URL=\S+$/m);
  return { api: client(/AGENTRUN_BASE_URL=(\S+)/.exec(out)[1], token), stop: async () => (await stop(), out) };
}

test("under its launcher the seal key is made once, outside the data directory, 0600 in a 0700 directory; a lost one comes back as another key, so the saved keys are asked for again; no file under the data directory and no log line holds a key in any form", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const [data, config] = [join(dir, "agents"), join(dir, "config")];
  const keyFile = join(config, "agentrun", "seal.key");
  const token = `not-a-secret-token-${randomBytes(16).toString("hex")}`;
  const values = { PARALLEL_API_KEY: made(), BROWSERBASE_API_KEY: made(), BROWSERBASE_PROJECT_ID: made() };
  const said = [];
  let server = await launched(t, data, config, token);
  assert.equal(statSync(join(config, "agentrun")).mode & 0o777, 0o700);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const first = readFileSync(keyFile, "utf8").trim();
  assert.equal(Buffer.from(first, "base64").length, 32);
  assert.deepEqual((await server.api("GET", "/capabilities")).body.features.tool_keys, { routes: true, at_rest: "sealed" });
  assert.equal((await server.api("POST", "/agents", agent("keys"))).status, 201, "the store holds something too");
  assert.equal((await server.api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: values.PARALLEL_API_KEY } })).status, 204);
  assert.equal((await server.api("PUT", "/settings/tool-keys/browserbase", { values: { BROWSERBASE_API_KEY: values.BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID: values.BROWSERBASE_PROJECT_ID } })).status, 204);
  said.push(JSON.stringify((await server.api("GET", "/settings/tool-keys")).body), await server.stop());

  server = await launched(t, data, config, token);
  assert.equal(readFileSync(keyFile, "utf8").trim(), first, "the same key, read back");
  const kept = (await server.api("GET", "/settings/tool-keys")).body;
  assert.deepEqual([fieldsOf(kept).PARALLEL_API_KEY, kept.reenter], [STORED, null]);
  said.push(JSON.stringify(kept), await server.stop());

  rmSync(keyFile);
  server = await launched(t, data, config, token);
  const second = readFileSync(keyFile, "utf8").trim();
  assert.notEqual(second, first, "a lost key is made anew");
  const lost = (await server.api("GET", "/settings/tool-keys")).body;
  assert.deepEqual(lost.reenter, { reason: "seal_key_changed", fields: Object.keys(values) }, "missing shows as changed: the launcher made another");
  said.push(JSON.stringify(lost), await server.stop());
  assert.ok(said.at(-1).includes(`event=tool_keys condition=seal_key_changed file=${join(data, "tool-keys.json")} fields=${Object.keys(values).join(",")}`), said.at(-1));
  assert.deepEqual(readdirSync(join(config, "agentrun")), ["seal.key"], "nothing else beside it");

  const files = readdirSync(data, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  assert.ok(files.some((file) => file.endsWith("tool-keys.json")) && files.some((file) => file.endsWith("store.sqlite")), files.join(" "));
  const forms = [...Object.values(values).flatMap(formsOf), ...keyForms(first), ...keyForms(second)];
  // The positive control: the same check finds the key in the file that does hold it, and a value written out plain.
  assert.throws(() => holdsNone(readFileSync(keyFile), forms, "seal.key"));
  assert.throws(() => holdsNone(`x${Buffer.from(values.BROWSERBASE_PROJECT_ID).toString("hex")}x`, forms, "a hex value"));
  for (const file of files) holdsNone(readFileSync(file), forms, file);
  holdsNone(said.join("\n"), forms, "the server's log and answers");
});

test("under its launcher, a config directory the person made with a plain mkdir (0755) and no key yet: the launcher tightens its own directory to 0700, makes the key 0600, and the server keeps tool keys", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const [data, config] = [join(dir, "agents"), join(dir, "config")];
  const keys = join(config, "agentrun");
  mkdirSync(keys, { recursive: true });
  chmodSync(keys, 0o755);
  const token = `not-a-secret-token-${randomBytes(16).toString("hex")}`;
  const server = await launched(t, data, config, token);
  assert.equal(statSync(keys).mode & 0o777, 0o700, "its own directory, tightened before the key was written");
  assert.equal(statSync(join(keys, "seal.key")).mode & 0o777, 0o600);
  assert.deepEqual((await server.api("GET", "/capabilities")).body.features.tool_keys, { routes: true, at_rest: "sealed" });
  const out = await server.stop();
  assert.ok(!out.includes("no seal key"), out);
});

test("under its launcher, a key that already exists in a directory another user can read is refused and never changed: nothing is chmod-ed, and the message names the exact fix", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const [data, config] = [join(dir, "agents"), join(dir, "config")];
  const keys = join(config, "agentrun");
  mkdirSync(keys, { recursive: true });
  chmodSync(keys, 0o755);
  const key = randomBytes(32).toString("base64");
  writeFileSync(join(keys, "seal.key"), `${key}\n`, { mode: 0o600 });
  const token = `not-a-secret-token-${randomBytes(16).toString("hex")}`;
  const server = await launched(t, data, config, token);
  assert.deepEqual((await server.api("GET", "/capabilities")).body.features.tool_keys, { routes: true, at_rest: "unavailable" });
  const out = await server.stop();
  assert.equal(statSync(keys).mode & 0o777, 0o755, "an existing key's directory is never changed");
  assert.equal(readFileSync(join(keys, "seal.key"), "utf8").trim(), key, "the key is untouched");
  assert.ok(out.includes(`no seal key in ${join(keys, "seal.key")}`) && out.includes(`chmod 700 ${keys}; chmod 600 ${join(keys, "seal.key")}`), out);
});

test("under its launcher, a key directory that is a symlink is never chmod-ed: a shared target keeps its mode, even when the user owns it", { timeout: 60_000 }, async (t) => {
  const dir = await scratch(t);
  const [data, config, shared] = [join(dir, "agents"), join(dir, "config"), join(dir, "shared")];
  const keys = join(config, "agentrun");
  mkdirSync(config, { recursive: true });
  mkdirSync(shared, { recursive: true });
  chmodSync(shared, 0o755);
  symlinkSync(shared, keys);
  const token = `not-a-secret-token-${randomBytes(16).toString("hex")}`;
  const server = await launched(t, data, config, token);
  await server.stop();
  assert.equal(statSync(shared).mode & 0o777, 0o755, "the symlink's shared target keeps its mode");
});

test("a key a harness reads, saved later, makes the harness available with no restart: the server's reading probes the harnesses' offers with it", async (t) => {
  if (secret("ANTHROPIC_API_KEY")) return t.skip("this process holds an Anthropic key of its own");
  let saved;
  const stored = (name) => (name === "ANTHROPIC_API_KEY" ? saved : undefined);
  // Its data holds Claude Code, as a first use installs it.
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, AGENTRUN_SERVE_DATA: await harnessData(t) };
  const claude = async () => (await readingOf(base, 4, stored)).caps.harnesses.find((offer) => offer.id === "claude-agent");
  assert.deepEqual([(await claude()).available, (await claude()).reason], [false, "claude-agent needs ANTHROPIC_API_KEY or OPENROUTER_API_KEY."]);
  saved = ["not-a-secret", "anthropic"].join("-");
  // How many fit at once is this host's memory (admission.test.mjs).
  const { max_concurrent_runs, ...offer } = await claude();
  assert.deepEqual(offer, { id: "claude-agent", available: true, steer: false, default_model: "anthropic/claude-sonnet-5-5", run_memory_mib: 288 }, "saved: offered, on the key's default model");
  saved = undefined;
  assert.equal((await claude()).available, false, "deleted: not offered");
});

test("TypeSafe's key unlocks Jev's decisions: saved, the jev provider is available with no restart and the key reads as stored; deleted, it is missing again", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, [...KEYS, "OPENROUTER_API_KEY"]);
  const { api } = await serve(t);
  const jev = async () => (await api("GET", "/capabilities")).body.workflows.decisions.providers.find((provider) => provider.id === "jev").available;
  const row = async () => (await api("GET", "/settings/tool-keys")).body.keys.find((key) => key.id === "typesafe");
  assert.deepEqual(await row(), { id: "typesafe", kind: "tool", label: "TypeSafe (Jev)", unlocks: ["decisions.jev"], harnesses: [], fields: [{ name: "TYPESAFE_API_KEY", ...UNSET }], check: null });
  assert.equal(await jev(), false);
  assert.equal((await api("PUT", "/settings/tool-keys/typesafe", { values: { TYPESAFE_API_KEY: made() } })).status, 204);
  assert.deepEqual([await jev(), (await row()).fields], [true, [{ name: "TYPESAFE_API_KEY", ...STORED }]], "no restart");
  assert.equal((await api("DELETE", "/settings/tool-keys/typesafe")).status, 204);
  assert.equal(await jev(), false);
  await meetsDocument(api, (await api("GET", "/settings/tool-keys")).body);
});

test("a tool-settings PUT and a tool key's PUT and DELETE answer without probing the harnesses again, and capabilities read right after show each change", async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: sealKey() }, KEYS);
  const lines = [];
  const { api } = await serve(t, { log: (line) => void lines.push(line) });
  const caps = async () => (await api("GET", "/capabilities")).body;
  const tool = async (name) => (await caps()).tools.find((entry) => entry.name === name);
  const parallel = async () => (await caps()).workflows.decisions.providers.find((provider) => provider.id === "parallel").available;
  const harnesses = (await caps()).harnesses;

  assert.equal((await api("PUT", "/settings/tools", { web_search: { provider: "off" } })).status, 200);
  const off = await tool("web_search");
  assert.deepEqual([off.available, [...new Set(Object.values(off.resolves))]], [false, ["unavailable: web_search is turned off in settings"]], "off at once");
  assert.equal((await api("PUT", "/settings/tools", { web_search: { provider: "parallel" } })).status, 200);
  assert.deepEqual([(await tool("web_search")).available, (await tool("web_search")).missing, await parallel()], [false, ["PARALLEL_API_KEY"], false], "Parallel picked, no key");
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: made() } })).status, 204);
  const picked = await tool("web_search");
  assert.deepEqual([picked.available, picked.missing, [...new Set(Object.values(picked.resolves))], await parallel()], [true, undefined, ["parallel"], true], "the key saved: Parallel resolves, and its decisions run, at once");
  assert.equal((await api("PUT", "/settings/tool-keys/monid", { values: { MONID_API_KEY: made() } })).status, 204);
  assert.deepEqual([(await tool("monid.run")).available, (await tool("monid.run")).missing], [true, undefined], "monid at once");
  assert.equal((await api("DELETE", "/settings/tool-keys/monid")).status, 204);
  assert.deepEqual([(await tool("monid.run")).available, (await tool("monid.run")).missing], [false, ["MONID_API_KEY"]], "deleted: missing at once");
  assert.equal((await api("DELETE", "/settings/tool-keys/parallel")).status, 204);
  assert.deepEqual([(await tool("web_search")).missing, await parallel()], [["PARALLEL_API_KEY"], false], "deleted: Parallel missing at once");
  assert.deepEqual((await caps()).harnesses, harnesses, "no tool key and no tool setting changes what the harnesses offer");

  // Probes counted, not timed: the server logs each probe of the harnesses (event=harness_offers), and it made one, at its
  // start, around the six writes it logged; none of them probed again.
  const events = lines.flatMap((line) => {
    const probe = / event=harness_offers why=(\S+)/.exec(line);
    const write = / event=request method=(PUT|DELETE) path=(\/v2\/settings\/tool\S*)/.exec(line);
    return probe ? [`probe:${probe[1]}`] : write ? [`${write[1]} ${write[2]}`] : [];
  });
  assert.deepEqual(events, ["probe:start", "PUT /v2/settings/tools", "PUT /v2/settings/tools", "PUT /v2/settings/tool-keys/parallel", "PUT /v2/settings/tool-keys/monid", "DELETE /v2/settings/tool-keys/monid", "DELETE /v2/settings/tool-keys/parallel"]);
});
