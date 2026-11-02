// Tool keys saved by name through /v2/settings/tool-keys: kept in the data directory as ciphertext alone, under a seal
// key the launcher hands the server from outside it. GET names each field and where it is set, never a value. A value
// that does not open (no seal key, another one, a damaged file) is asked for again, said once in the log, and never
// stops the server; there is no clear fallback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { unseal } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { schemaProblems } from "./schema-support.mjs";
import { agent, call, client, cookieOf, FAUX, scratch, serve, withEnv } from "./support.mjs";

const LAUNCHER = new URL("../launcher/agentrun-serve", import.meta.url).pathname;
const KEYS = ["PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID", "AGENTRUN_SEAL_KEY"];
const sealKey = () => randomBytes(32).toString("base64");
/** A throwaway value: none is a real key. */
const made = () => `not-a-secret-${randomBytes(12).toString("hex")}`;
/** Each form a value could plausibly leak in: as text, base64, base64url and hex, and its random part's first 8. */
const formsOf = (value) => [value, ...["base64", "base64url", "hex"].map((code) => Buffer.from(value).toString(code)), value.slice(13, 21)];
/** A seal key's forms: its base64 text, its bytes, and those as hex and base64url. */
const keyForms = (key) => [key, Buffer.from(key, "base64"), ...["hex", "base64url"].map((code) => Buffer.from(key, "base64").toString(code))];
const holdsNone = (bytes, forms, where) => { for (const form of forms) assert.ok(!Buffer.from(bytes).includes(form), `${where} holds a key (${String(form).length} long)`); };
const fieldsOf = (view) => Object.fromEntries(view.keys.flatMap((key) => key.fields.map(({ name, ...field }) => [name, field])));
const STORED = { set: true, source: "stored" };
const UNSET = { set: false, source: null };
const AGAIN = { set: false, source: null, stored_unreadable: true };
/** GET's answer meets the schema the served document gives it. */
async function meetsDocument(api, view) {
  const doc = (await api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(doc, doc.paths["/settings/tool-keys"].get.responses["200"].content["application/json"].schema, view), [], JSON.stringify(view));
}

test("a key saved by name is kept sealed: GET says which fields are set and from where, never a value; PUT merges by field, DELETE forgets; the file is 0600 and holds no value", async (t) => {
  const key = sealKey();
  withEnv(t, { AGENTRUN_SEAL_KEY: key }, KEYS);
  const { api, data } = await serve(t);
  const values = { PARALLEL_API_KEY: made(), BROWSERBASE_API_KEY: made(), BROWSERBASE_PROJECT_ID: made() };
  assert.equal((await api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: values.PARALLEL_API_KEY } })).status, 204);
  assert.equal((await api("PUT", "/settings/tool-keys/browserbase", { values: { BROWSERBASE_API_KEY: values.BROWSERBASE_API_KEY } })).status, 204);
  assert.equal((await api("PUT", "/settings/tool-keys/browserbase", { values: { BROWSERBASE_PROJECT_ID: values.BROWSERBASE_PROJECT_ID } })).status, 204, "one field of two, the other kept");
  const listed = await api("GET", "/settings/tool-keys");
  assert.equal(listed.status, 200);
  assert.deepEqual(fieldsOf(listed.body), { PARALLEL_API_KEY: STORED, MONID_API_KEY: UNSET, BROWSERBASE_API_KEY: STORED, BROWSERBASE_PROJECT_ID: STORED });
  assert.deepEqual(listed.body.keys.map((k) => [k.id, k.unlocks, k.harnesses]), [
    ["parallel", ["web_fetch", "web_search", "decisions.parallel"], ["pi", "claude-agent", "codex"]],
    ["monid", ["monid.discover", "monid.inspect", "monid.run"], ["pi"]],
    ["browserbase", ["browser"], ["pi"]],
  ]);
  // Each key's harnesses are those capabilities give every tool it unlocks, so the two cannot drift apart.
  const tools = Object.fromEntries((await api("GET", "/capabilities")).body.tools.map((tool) => [tool.name, tool.harnesses]));
  for (const key of listed.body.keys) for (const name of key.unlocks.filter((unlock) => unlock in tools)) assert.deepEqual(tools[name], key.harnesses, `${key.id} unlocks ${name}`);
  assert.deepEqual(listed.body.keys.find((key) => key.id === "monid").unlocks.filter((name) => name in tools), ["monid.discover", "monid.inspect", "monid.run"], "each monid tool is checked");
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
  assert.deepEqual(fieldsOf((await api("GET", "/settings/tool-keys")).body), { PARALLEL_API_KEY: STORED, MONID_API_KEY: UNSET, BROWSERBASE_API_KEY: UNSET, BROWSERBASE_PROJECT_ID: UNSET });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).fields), ["PARALLEL_API_KEY"]);
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
  assert.deepEqual(fieldsOf(view), { PARALLEL_API_KEY: { set: true, source: "server" }, MONID_API_KEY: UNSET, BROWSERBASE_API_KEY: { set: true, source: "server" }, BROWSERBASE_PROJECT_ID: STORED });
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
  assert.deepEqual(server.said().map((line) => line.replace(/^at=\S+ /, "")), [`event=tool_keys condition=seal_key_changed file=${file} fields=PARALLEL_API_KEY,MONID_API_KEY`], "said once, at the start");
  const changed = (await server.api("GET", "/settings/tool-keys")).body;
  assert.deepEqual([fieldsOf(changed).PARALLEL_API_KEY, fieldsOf(changed).MONID_API_KEY, changed.reenter], [AGAIN, AGAIN, { reason: "seal_key_changed", fields: ["PARALLEL_API_KEY", "MONID_API_KEY"] }]);
  assert.equal(server.said().length, 1, "not again for the same condition");
  await meetsDocument(server.api, changed);
  assert.equal((await server.api("PUT", "/settings/tool-keys/parallel", { values: { PARALLEL_API_KEY: values.PARALLEL_API_KEY } })).status, 204);
  const resealed = (await server.api("GET", "/settings/tool-keys")).body;
  assert.deepEqual([fieldsOf(resealed).PARALLEL_API_KEY, resealed.reenter], [STORED, { reason: "seal_key_changed", fields: ["MONID_API_KEY"] }], "sealed anew under the current key");
  await server.close();

  server = await started(undefined);
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
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const stop = async () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    await exited;
  };
  t.after(stop);
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  for (let i = 0; !/AGENTRUN_BASE_URL=(\S+)/.test(out); i++) {
    assert.ok(i < 300, `the server started: ${out}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
