// A Composio trigger's config can hold a credential: HubSpot's deal-stage event takes {app_id, developer_api_key}. A field
// named like a key, token, secret, password or credential (trigger-composio.ts sealedConfigFields: Composio's trigger
// schemas mark no field secret) is sealed at the save, in the composio source's sealed settings beside the
// subscription's secret, and the trigger keeps "[sealed]" in its place with the field named in `sealed_config`. Composio
// gets the real value at the upsert. No answer, stored row, Idempotency-Key record or log line holds it. A PATCH that
// leaves it out or sends "[sealed]" keeps it; one that sends another value is refused, as any change to a composio
// trigger's config is. A trigger saved with its key in the clear before this rule is answered masked all the same, and
// sealed at the next start. An Idempotency-Key's record keeps a keyed digest of the body and the masked answer; one an
// older server wrote is scrubbed at the start.
import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { scratch, secretWritePath, serve, triggerStore } from "./support.mjs";
import { made } from "./trigger-support.mjs";

secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);

const PUBLIC = "https://agentrun.example.com";
const MASK = "[sealed]";
const TOOLS = [{ slug: "HUBSPOT_LIST_DEALS", name: "List deals", description: "Lists deals." }];
/** A HubSpot event whose config takes a developer key, shaped as the fake's GitHub events are (fake-composio.mjs). */
const DEAL_STAGE = {
  slug: "HUBSPOT_DEAL_STAGE_UPDATED_TRIGGER", name: "Deal Stage Updated", description: "Triggered when a deal's stage changes.", instructions: "", type: "webhook", types: ["webhook"],
  toolkit: { slug: "hubspot", name: "HubSpot", logo: "" }, version: "20260101_00",
  config: { type: "object", title: "WebhookConfigSchema", required: ["app_id", "developer_api_key"], properties: { app_id: { type: "string", title: "App Id" }, developer_api_key: { type: "string", title: "Developer Api Key" } } },
  payload: { type: "object", properties: {} },
};

/** A fake key, new each test: never a real one. */
const fakeKey = () => `fake-hubspot-dev-${randomBytes(10).toString("hex")}`;
/** A fake numeric key, 13 digits, new each test. */
const fakeNumber = () => 9_000_000_000_000 + randomInt(0, 2 ** 40);

/** A server with a saved HubSpot Composio server `hs`, connected, and an agent `triage`. Every answer and log line is
 *  kept, for the key's check. */
async function setup(t, { server: options = {}, composio: given = {} } = {}) {
  const composio = await startFakeComposio({ toolkits: { hubspot: { no_auth: false, tools: TOOLS } }, authConfigs: { hubspot: [{ id: "ac_managed", is_composio_managed: true }] }, active: ["hubspot"], triggerTypes: { hubspot: [DEAL_STAGE] }, ...given });
  t.after(() => composio.close());
  const lines = [];
  const server = await serve(t, { publicUrl: PUBLIC, composioControl: { baseUrl: composio.baseUrl }, log: (line) => lines.push(line), ...options });
  const answers = [];
  const api = async (...args) => {
    const res = await server.api(...args);
    answers.push(JSON.stringify(res.body));
    return res;
  };
  const saved = await api("PUT", "/settings/mcp-servers/hs/composio", { api_key: composio.apiKey, toolkit: "hubspot", tools: ["HUBSPOT_LIST_DEALS"], user_id: "agentrun-qa" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await made(api, "triage");
  return { composio, server, api, lines, answers };
}

let count = 0;
const dealTrigger = (key, extra = {}) => ({
  name: `deals ${++count}`,
  source: { kind: "composio", server: "hs", event: DEAL_STAGE.slug, config: { app_id: "4242", developer_api_key: key } },
  target: { kind: "start_run", agent_id: "triage", input: { content: "Note the deal's new stage." }, max_cost_usd: 0.5 },
  ...extra,
});

/** Every file under `dir`, by path. */
function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    return !stat ? [] : stat.isDirectory() ? filesUnder(path) : stat.isFile() ? [path] : [];
  });
}

/** The composio source's live sealed rows for trigger `id`'s config (a value removed is kept retired, under its own
 *  scope, for the redaction list alone: not one of these). */
const sealedRowsOf = async (store, id) => (await store.triggerSettings.get("composio")).filter((row) => row.scope.startsWith(`config:${id}:`));

test("a create's answer shows a key-named config field as [sealed], names it in sealed_config, and the other fields as given", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const res = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(res.status, 201, res.status === 201 ? "" : JSON.stringify(res.body));
  assert.ok(!JSON.stringify(res.body).includes(key), "the create's answer holds no key");
  assert.equal(res.body.source.config.developer_api_key, MASK);
  assert.deepEqual(res.body.source.sealed_config, ["developer_api_key"]);
  assert.equal(res.body.source.config.app_id, "4242", "a field that names no secret is answered as given");
});

test("GET /triggers/{id} and GET /triggers never show the sealed value", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  const one = await s.api("GET", `/triggers/${made.body.id}`);
  assert.equal(one.status, 200);
  assert.ok(!JSON.stringify(one.body).includes(key), "GET /triggers/{id} holds no key");
  assert.equal(one.body.source.config.developer_api_key, MASK);
  const all = await s.api("GET", "/triggers");
  assert.ok(!JSON.stringify(all.body).includes(key), "GET /triggers holds no key");
});

test("Composio gets the real value at the upsert: its instance watches with the key", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  const [instance] = [...s.composio.instances.values()];
  assert.deepEqual(instance?.trigger_config, { app_id: "4242", developer_api_key: key }, "the upsert sent the real config");
  assert.equal(made.body.source.instance_id, instance.id);
});

test("no file in the data directory holds the key: the trigger's row keeps it sealed", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  const holding = filesUnder(s.server.data).filter((path) => readFileSync(path).includes(key));
  assert.deepEqual(holding, [], "no file under the data directory holds the key in the clear");
  assert.equal((await sealedRowsOf(s.server.store, made.body.id)).length, 1, "the key is kept as one sealed row");
});

test("a create under an Idempotency-Key keeps no key in the key's record (.idempotency.json), and a retry still replays", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const body = dealTrigger(key);
  const first = await s.api("POST", "/triggers", body, { "idempotency-key": "deal-once" });
  assert.equal(first.status, 201, first.status === 201 ? "" : JSON.stringify(first.body));
  const record = readFileSync(join(s.server.data, ".idempotency.json"), "utf8");
  assert.ok(!record.includes(key), "the Idempotency-Key's record holds no key");
  const again = await s.api("POST", "/triggers", body, { "idempotency-key": "deal-once" });
  assert.equal(again.status, 201);
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(again.body.id, first.body.id, "the retry replays the first answer");
});

test("a PATCH that sends the source back as read, [sealed] in place, keeps the sealed value", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  const { source } = made.body;
  const res = await s.api("PATCH", `/triggers/${made.body.id}`, { name: "renamed", source: { ...source, config: { app_id: "4242", developer_api_key: MASK } } });
  assert.equal(res.status, 200, `a PATCH that sends [sealed] keeps the key: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.source.config.developer_api_key, MASK);
  assert.deepEqual(res.body.source.sealed_config, ["developer_api_key"]);
  assert.equal((await sealedRowsOf(s.server.store, made.body.id)).length, 1, "the sealed value is kept");
  assert.equal(s.composio.instances.size, 1, "nothing new made on Composio");
});

test("a PATCH whose config leaves the sealed field out keeps it", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  const res = await s.api("PATCH", `/triggers/${made.body.id}`, { source: { kind: "composio", server: "hs", event: DEAL_STAGE.slug, config: { app_id: "4242" } } });
  assert.equal(res.status, 200, `a PATCH that leaves the sealed field out keeps it: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.source.config.developer_api_key, MASK);
  assert.equal((await sealedRowsOf(s.server.store, made.body.id)).length, 1, "the sealed value is kept");
});

test("a PATCH that sends another value is refused, as any change to the config is, and its answer holds neither key", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const other = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  const res = await s.api("PATCH", `/triggers/${made.body.id}`, { source: { kind: "composio", server: "hs", event: DEAL_STAGE.slug, config: { app_id: "4242", developer_api_key: other } } });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.error.fields[0].field, "source.config");
  assert.ok(![key, other].some((one) => JSON.stringify(res.body).includes(one)), "the refusal holds no key");
});

test("deleting the trigger removes its sealed value", async (t) => {
  const s = await setup(t);
  const made = await s.api("POST", "/triggers", dealTrigger(fakeKey()));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  assert.equal((await sealedRowsOf(s.server.store, made.body.id)).length, 1, "the key is kept sealed while the trigger is");
  const gone = await s.api("DELETE", `/triggers/${made.body.id}`);
  assert.ok(gone.status === 204 || gone.status === 200, JSON.stringify(gone.body));
  assert.equal((await sealedRowsOf(s.server.store, made.body.id)).length, 0, "the sealed value goes with the trigger");
});

test("no log line, answer or Composio step's words hold the key, through create, pause, resume, rename and delete", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  await s.api("PATCH", `/triggers/${made.body.id}`, { enabled: false });
  await s.api("PATCH", `/triggers/${made.body.id}`, { enabled: true });
  await s.api("PATCH", `/triggers/${made.body.id}`, { name: "renamed" });
  await s.api("GET", "/settings/mcp-servers/hs/composio/triggers");
  await s.api("DELETE", `/triggers/${made.body.id}`);
  assert.ok(!s.answers.some((a) => a.includes(key)), "no answer holds the key");
  assert.ok(!s.lines.some((l) => l.includes(key)), "no log line holds the key");
});

test("a refusal of Composio's at the upsert that quotes the config holds no key in its answer or the log", async (t) => {
  const key = fakeKey();
  // Composio's 400 for a config it refuses, quoting what it was sent, as some of its errors do.
  const s = await setup(t, { composio: { fail: { path: "/upsert", status: 400, body: { error: { message: `Invalid trigger config: ${JSON.stringify({ app_id: "4242", developer_api_key: key })}` } } } } });
  const res = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.ok(!JSON.stringify(res.body).includes(key), "the refusal's answer holds no key");
  assert.ok(!s.lines.some((l) => l.includes(key)), "no log line holds the key");
});

test("a trigger saved with its key in the clear before this rule is sealed at the next start; Composio's instance is left as it is", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  // The row as a server before this rule kept it: the config whole, no sealed_config.
  const { sealed_config: _, ...source } = made.body.source;
  await s.server.store.triggers.update(made.body.id, { source: { ...source, config: { app_id: "4242", developer_api_key: key } } });
  await livedWith(s.api, made.body.id);
  await s.server.stop();
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl } });
  const read = await again.api("GET", `/triggers/${made.body.id}`);
  assert.equal(read.status, 200);
  assert.ok(!JSON.stringify(read.body).includes(key), "the next start seals a key kept in the clear");
  assert.equal(read.body.source.config.developer_api_key, MASK);
  assert.deepEqual(read.body.source.sealed_config, ["developer_api_key"]);
  assert.equal(read.body.source.instance_id, made.body.source.instance_id, "the trigger keeps its instance");
  assert.deepEqual([...s.composio.instances.values()][0].trigger_config, { app_id: "4242", developer_api_key: key }, "Composio's instance is left as it is");
  // On disk too: the store's database file, its WAL and journal, and their free pages hold no copy of the row it rewrote.
  const holding = filesUnder(again.data).filter((path) => readFileSync(path).includes(key));
  assert.deepEqual(holding, [], "once the start sealed it, no file under the data directory holds the key: the old row's bytes are gone");
});

test("the events list names, for each event, the config fields a save seals", async (t) => {
  const s = await setup(t);
  const res = await s.api("GET", "/settings/mcp-servers/hs/composio/events");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [deal] = res.body.events;
  assert.deepEqual(deal.sealed, ["developer_api_key"], "the console's form reads which fields to take as a password");
});

test("the name rule: a field named like a key, token, secret, password or credential is sealed when its value is a string; ids, counts and names are not", async () => {
  const composio = await import("../dist/trigger-composio.js");
  assert.equal(typeof composio.sealedConfigFields, "function", "trigger-composio.ts says which config fields are sealed");
  const sealed = ["developer_api_key", "api_key", "apiKey", "APIKey", "apikey", "key", "private_key", "access_key", "client_secret", "secret", "webhook_secret", "access_token", "token", "refreshToken", "bot_token", "password", "passwd", "passphrase", "credential", "credentials", "auth_token", "signing_key", "authorization", "Authorization", "bearer", "bearer_value", "cookie", "session_cookie", "setCookie"];
  const kept = ["app_id", "owner", "repo", "key_id", "keyword", "keywords", "channel_id", "monkey", "turkey", "secretary", "tokenizer", "author"];
  const config = Object.fromEntries([...sealed, ...kept].map((name) => [name, `value-of-${name}`]));
  assert.deepEqual(composio.sealedConfigFields(config).sort(), [...sealed].sort());
  assert.deepEqual(composio.sealedConfigFields({ token: true, secret: { nested: "x" }, password: "", apikey: null }), [], "a switch, an object, an empty string or null is no credential to seal");
});

test("the name rule, wider: a plural (tokens, secrets, api_keys), hapikey, pat, pwd, passcode, jwt, dsn and connection_string are sealed; key_id, keyword, status, pattern, path and address are not", async () => {
  const composio = await import("../dist/trigger-composio.js");
  const sealed = ["tokens", "secrets", "api_keys", "apiKeys", "private_keys", "passwords", "access_tokens", "client_secrets", "cookies", "credentials", "hapikey", "HAPIKEY", "pat", "github_pat", "pwd", "db_pwd", "passcode", "jwt", "jwt_value", "dsn", "sentry_dsn", "connection_string", "connectionString", "db_connection_string", "connection_strings"];
  const kept = ["key_id", "keyword", "keywords", "status", "pattern", "patterns", "path", "paths", "address", "addresses", "patch", "process", "progress", "connection", "connection_id", "string", "string_value", "string_connection", "keys_count", "app_id"];
  const config = Object.fromEntries([...sealed, ...kept].map((name) => [name, `value-of-${name}`]));
  assert.deepEqual(composio.sealedConfigFields(config).sort(), [...sealed].sort(), "each of these names is sealed, and none of the kept ones");
});

test("a number under a credential's name is sealed as a string is: the answer masks it, Composio's instance gets the number, no file holds its digits, and a PATCH that leaves it out keeps it", async (t) => {
  const composio = await import("../dist/trigger-composio.js");
  assert.deepEqual(composio.sealedConfigFields({ api_key: 12345678901, pin_secret: 0, token: true, count: 3 }).sort(), ["api_key", "pin_secret"], "a number under a credential's name is sealed; a switch is not");
  const s = await setup(t);
  const number = fakeNumber();
  const made = await s.api("POST", "/triggers", dealTrigger(number));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  assert.equal(made.body.source.config.developer_api_key, MASK);
  assert.deepEqual(made.body.source.sealed_config, ["developer_api_key"]);
  const instance = [...s.composio.instances.values()][0];
  assert.equal(instance.trigger_config.developer_api_key, number, "Composio's instance gets the number, as a number");
  const read = await s.api("GET", `/triggers/${made.body.id}`);
  assert.equal(read.body.source.config.developer_api_key, MASK);
  assert.equal((await sealedRowsOf(s.server.store, made.body.id)).length, 1);
  assert.deepEqual(filesUnder(s.server.data).filter((path) => readFileSync(path).includes(String(number))), [], "no file under the data directory holds its digits");
  const kept = await s.api("PATCH", `/triggers/${made.body.id}`, { source: { kind: "composio", server: "hs", event: DEAL_STAGE.slug, config: { app_id: "4242" } } });
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  assert.ok(![...s.answers, ...s.lines].some((one) => one.includes(String(number))), "no answer or log line holds its digits");
});

test("a number an earlier server kept in the clear, at the top level and below it: masked on reads, sealed at the next start with no file holding its digits, and a PATCH that leaves the nested one out keeps it", async (t) => {
  const s = await setup(t);
  const key = fakeNumber();
  const inner = fakeNumber();
  const made = await s.api("POST", "/triggers", dealTrigger(fakeKey()));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  const { sealed_config: _, ...source } = made.body.source;
  await s.server.store.triggers.update(made.body.id, { source: { ...source, config: { app_id: "4242", developer_api_key: key, auth: { api_key: inner, region: "eu" } } } });
  const one = await s.api("GET", `/triggers/${made.body.id}`);
  assert.ok(![key, inner].some((n) => JSON.stringify(one.body).includes(String(n))), `GET masks a number at any depth: ${JSON.stringify(one.body.source.config)}`);
  assert.equal(one.body.source.config.auth.api_key, MASK);
  assert.deepEqual([...one.body.source.sealed_config].sort(), ["/auth/api_key", "developer_api_key"]);
  await s.server.stop();
  const lines = [];
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl }, log: (line) => lines.push(line) });
  assert.equal((await sealedRowsOf(again.store, made.body.id)).length, 2, "both numbers are sealed at the start (the top-level one in the place of the key the create sealed)");
  assert.deepEqual(filesUnder(again.data).filter((path) => [key, inner].some((n) => readFileSync(path).includes(String(n)))), [], "no file under the data directory holds either's digits");
  assert.ok(!lines.some((l) => [key, inner].some((n) => l.includes(String(n)))), "no log line holds either");
  const left = await again.api("PATCH", `/triggers/${made.body.id}`, { source: { kind: "composio", server: "hs", event: DEAL_STAGE.slug, config: { app_id: "4242", auth: { region: "eu" } } } });
  assert.equal(left.status, 200, `a PATCH that leaves the nested number out keeps it: ${JSON.stringify(left.body)}`);
  assert.equal((await again.api("GET", `/triggers/${made.body.id}`)).body.source.config.auth.api_key, MASK);
});

/** An event whose schema marks its credentials as JSON Schema does (format: password, writeOnly), under names the name rule
 *  passes over, and a numeric one under a credential's name. */
const FORM_EVENT = {
  ...DEAL_STAGE, slug: "HUBSPOT_FORM_SUBMITTED_TRIGGER", name: "Form Submitted",
  config: { type: "object", required: ["app_id"], properties: { app_id: { type: "string" }, hub_value: { type: "string", format: "password" }, signing_material: { type: "string", writeOnly: true }, secret_pin: { type: "integer" }, region: { type: "string" } } },
};

test("a field whose schema says format: password or writeOnly is sealed whatever its name, and a numeric credential is listed too: the events list names them, a create seals them and Composio gets them", async (t) => {
  const s = await setup(t, { composio: { triggerTypes: { hubspot: [DEAL_STAGE, FORM_EVENT] } } });
  const events = await s.api("GET", "/settings/mcp-servers/hs/composio/events");
  assert.equal(events.status, 200, JSON.stringify(events.body));
  const form = events.body.events.find((event) => event.slug === FORM_EVENT.slug);
  assert.deepEqual([...form.sealed].sort(), ["hub_value", "secret_pin", "signing_material"], "the events list names the schema's credentials, and a numeric one by its name");
  const hub = fakeKey();
  const signing = fakeKey();
  const pin = fakeNumber();
  const made = await s.api("POST", "/triggers", { ...dealTrigger(""), source: { kind: "composio", server: "hs", event: FORM_EVENT.slug, config: { app_id: "4242", hub_value: hub, signing_material: signing, secret_pin: pin, region: "eu" } } });
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  assert.deepEqual(made.body.source.config, { app_id: "4242", hub_value: MASK, signing_material: MASK, secret_pin: MASK, region: "eu" }, "a create seals what the schema marks");
  assert.deepEqual([...made.body.source.sealed_config].sort(), ["hub_value", "secret_pin", "signing_material"]);
  assert.deepEqual([...s.composio.instances.values()][0].trigger_config, { app_id: "4242", hub_value: hub, signing_material: signing, secret_pin: pin, region: "eu" }, "Composio gets each as given");
  assert.ok(![hub, signing, String(pin)].some((v) => [...s.answers, ...s.lines].some((one) => one.includes(v))), "no answer or log line holds any");
  const kept = await s.api("PATCH", `/triggers/${made.body.id}`, { source: { kind: "composio", server: "hs", event: FORM_EVENT.slug, config: { app_id: "4242", region: "eu" } } });
  assert.equal(kept.status, 200, `a PATCH that leaves them out keeps them: ${JSON.stringify(kept.body)}`);
});

test("the API document: a composio source's sealed_config is read-only, and config's words say a key-named field is answered [sealed]", async (t) => {
  const { baseUrl } = await serve(t, { runner: false });
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  // Every composio source schema in the document.
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (node.properties?.kind?.const === "composio" && node.properties.config) found.push(node);
    Object.values(node).forEach(walk);
  };
  walk(doc);
  assert.ok(found.length > 0, "the document has the composio source");
  for (const composio of found) {
    assert.equal(composio.properties.sealed_config?.readOnly, true, "sealed_config is read-only");
    assert.match(composio.properties.config.description, /\[sealed\]/);
  }
});

/** A package whose composio trigger takes HubSpot's developer key from a parameter, under a fresh templates folder. */
async function keyPackage(t) {
  const root = join(await scratch(t), "templates");
  const dir = join(root, "deals");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), `---
name: deals
version: 0.1.0
description: Notes each deal's new stage.
budget: { per_run_usd: 0.5 }
parameters:
  app_id: { type: string, description: "the HubSpot app's id" }
  developer_api_key: { type: string, description: "the HubSpot app's developer key" }
mcp:
  - source: composio
    toolkit: hubspot
    tools: [HUBSPOT_LIST_DEALS]
    required: true
triggers:
  - name: deal-stage
    source:
      kind: composio
      server: hubspot
      event: ${DEAL_STAGE.slug}
      config:
        app_id: "\${parameters.app_id}"
        developer_api_key: \${parameters.developer_api_key}
    target: { kind: start_run, input: { content: "Note the deal's new stage." } }
---
Note the deal's new stage with mcp:hubspot/HUBSPOT_LIST_DEALS.
`);
  return root;
}

test("a template's composio trigger whose key comes from a parameter: the apply's answer and the trigger hold no key, Composio's instance does", async (t) => {
  const root = await keyPackage(t);
  const composio = await startFakeComposio({ toolkits: { hubspot: { no_auth: false, tools: TOOLS } }, authConfigs: { hubspot: [{ id: "ac_managed", is_composio_managed: true }] }, active: ["hubspot"], triggerTypes: { hubspot: [DEAL_STAGE] } });
  t.after(() => composio.close());
  const lines = [];
  const server = await serve(t, { templates: root, publicUrl: PUBLIC, composioControl: { baseUrl: composio.baseUrl }, log: (line) => lines.push(line) });
  const saved = await server.api("PUT", "/settings/mcp-servers/work-hubspot/composio", { api_key: composio.apiKey, toolkit: "hubspot", tools: ["HUBSPOT_LIST_DEALS"], user_id: "agentrun-qa" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const key = fakeKey();
  const applied = await server.api("POST", "/templates/deals/apply", { parameters: { app_id: "4242", developer_api_key: key } }, { "idempotency-key": "deals-once" });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.ok(!JSON.stringify(applied.body).includes(key), "the apply's answer holds no key");
  const read = await server.api("GET", `/triggers/${applied.body.trigger_ids[0]}`);
  assert.ok(!JSON.stringify(read.body).includes(key), "the trigger it made holds no key");
  assert.equal(read.body.source.config.developer_api_key, MASK);
  assert.deepEqual([...composio.instances.values()][0]?.trigger_config, { app_id: "4242", developer_api_key: key }, "Composio's instance watches with the key");
  assert.ok(!readFileSync(join(server.data, ".idempotency.json"), "utf8").includes(key), "the apply's Idempotency-Key record holds no key");
  assert.ok(!lines.some((l) => l.includes(key)), "no log line holds the key");
});

/** Trigger `id`'s ordinary life before the upgrade: other triggers made after it share its page, then a pause, a resume
 *  and renames each a little longer, as a firing's last_run_id and its counts change a row's size. Each rewrites the
 *  whole row, the key with it, and a row grown past the space it had leaves its old copy in the page's free space. */
async function livedWith(api, id) {
  for (const n of [1, 2, 3, 4]) assert.equal((await api("POST", "/triggers", dealTrigger(fakeKey()))).status, 201, `neighbour ${n}`);
  for (const change of [{ enabled: false }, { enabled: true }, ...[1, 2, 3, 4, 5].map((n) => ({ name: `deals ${"x".repeat(n * 9)}` }))]) {
    assert.equal((await api("PATCH", `/triggers/${id}`, change)).status, 200);
  }
}

/** Trigger `id`'s row rewritten as a server before this rule kept it: the config whole, in the clear, no sealed_config. */
async function keptInTheClear(store, trigger, key) {
  const { sealed_config: _, ...source } = trigger.source;
  await store.triggers.update(trigger.id, { source: { ...source, config: { app_id: "4242", developer_api_key: key } } });
}

test("a trigger kept in the clear is answered masked by the same rule before it is sealed: GET, the list and a PATCH's answer", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  await keptInTheClear(s.server.store, made.body, key);
  const one = await s.api("GET", `/triggers/${made.body.id}`);
  assert.ok(!JSON.stringify(one.body).includes(key), "GET masks a key the row keeps in the clear");
  assert.equal(one.body.source.config.developer_api_key, MASK);
  assert.deepEqual(one.body.source.sealed_config, ["developer_api_key"], "the masked field is named, sealed yet or not");
  const all = await s.api("GET", "/triggers");
  assert.ok(!JSON.stringify(all.body).includes(key), "the list masks it too");
  // The source sent back as read, [sealed] in place, is no change to the config.
  const renamed = await s.api("PATCH", `/triggers/${made.body.id}`, { name: "renamed", source: one.body.source });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.ok(!JSON.stringify(renamed.body).includes(key), "the PATCH's answer masks it");
});

test("the start's sealing: the sealed value is the real key under the server's seal key, its log names the trigger and field alone, and a second start seals nothing again", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  await keptInTheClear(s.server.store, made.body, key);
  await s.server.stop();
  const lines = [];
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl }, log: (line) => lines.push(line) });
  const said = lines.filter((line) => line.includes("composio_config_sealed"));
  assert.equal(said.length, 1, `one line says the trigger was sealed: ${JSON.stringify(lines.filter((l) => l.includes("composio")))}`);
  assert.ok(said[0].includes(made.body.id) && said[0].includes("developer_api_key"), `the line names the trigger and the field: ${said[0]}`);
  assert.ok(!lines.some((line) => line.includes(key)), "no log line holds the key");
  // What Composio's instance watches with is the key the trigger keeps sealed: the real one, never the mask.
  const { bootSealKey } = await import("../dist/seal-key.js");
  const { sealedSettingsOverStore } = await import("../dist/sealed-settings-store.js");
  const adapter = await import("../dist/trigger-composio.js");
  const seal = await bootSealKey(again.store, again.data, { role: "runner" });
  const settings = sealedSettingsOverStore(again.store, "composio", adapter.composio.settings, seal.key, () => undefined);
  await settings.load();
  assert.equal(settings.get(adapter.configScope(made.body.id, "developer_api_key"), adapter.CONFIG_SECRET), key, "the sealed value is the real key");
  assert.deepEqual([...s.composio.instances.values()][0].trigger_config, { app_id: "4242", developer_api_key: key }, "Composio's instance still has the real key");
  assert.equal(s.composio.instances.size, 1, "nothing new made on Composio");
  await again.stop();
  const third = [];
  const once = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl }, log: (line) => third.push(line) });
  assert.ok(!third.some((line) => line.includes("composio_config_sealed")), "a second start seals nothing again");
  assert.equal((await sealedRowsOf(once.store, made.body.id)).length, 1, "one sealed row still");
});

test("a PATCH that sends another key is refused in the fixed words, which say to delete the trigger and make a new one", async (t) => {
  const s = await setup(t);
  const made = await s.api("POST", "/triggers", dealTrigger(fakeKey()));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  const res = await s.api("PATCH", `/triggers/${made.body.id}`, { source: { kind: "composio", server: "hs", event: DEAL_STAGE.slug, config: { app_id: "4242", developer_api_key: fakeKey() } } });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.match(res.body.error.fields[0].message, /delete the trigger and make a new one/, "the fix text says how to change a key");
});

test("an Idempotency-Key's fingerprint is keyed (an HMAC under the server's seal key): no bare SHA-256 of the body, and the replay is the masked answer", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const body = dealTrigger(key);
  const first = await s.api("POST", "/triggers", body, { "idempotency-key": "deal-keyed" });
  assert.equal(first.status, 201, first.status === 201 ? "" : JSON.stringify(first.body));
  const { stable } = await import("../dist/validate.js");
  const { createHash } = await import("node:crypto");
  const bare = createHash("sha256").update(stable(body)).digest("hex");
  const record = readFileSync(join(s.server.data, ".idempotency.json"), "utf8");
  assert.ok(!record.includes(bare), "the record keeps no bare SHA-256 of the body, which a guess could be checked against");
  const [, kept] = JSON.parse(record).entries.find(([slot]) => slot.endsWith("\ndeal-keyed"));
  assert.match(kept.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(kept.answer.body.source.config.developer_api_key, MASK, "the record keeps the masked answer");
  const again = await s.api("POST", "/triggers", body, { "idempotency-key": "deal-keyed" });
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.ok(!JSON.stringify(again.body).includes(key), "the replay holds no key");
  assert.equal(again.body.source.config.developer_api_key, MASK);
  const other = await s.api("POST", "/triggers", dealTrigger(fakeKey()), { "idempotency-key": "deal-keyed" });
  assert.equal(other.status, 409, `another body under the key is a mismatch: ${JSON.stringify(other.body)}`);
});

test("an Idempotency-Key record an older server wrote, body and answer in the clear, is scrubbed at the start: the file holds no key, the replay is masked, and the log says a count alone", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const body = dealTrigger(key);
  const made = await s.api("POST", "/triggers", body);
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  await keptInTheClear(s.server.store, made.body, key);
  await s.server.stop();
  // The record as a server before this fix wrote it: the body itself as the fingerprint, the answer in the clear.
  const { stable } = await import("../dist/validate.js");
  const { sealed_config: _, ...source } = made.body.source;
  const answer = { status: 201, body: { ...made.body, source: { ...source, config: { app_id: "4242", developer_api_key: key } } }, headers: { location: `/v2/triggers/${made.body.id}` } };
  writeFileSync(join(s.server.data, ".idempotency.json"), JSON.stringify({ version: 1, entries: [[`/triggers\nolder-key`, { fingerprint: stable(body), at: Date.now(), answer }]] }), { mode: 0o600 });
  const lines = [];
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl }, log: (line) => lines.push(line) });
  assert.ok(!readFileSync(join(again.data, ".idempotency.json"), "utf8").includes(key), "the start rewrote the record: the file holds no key before any request");
  const scrubbed = lines.filter((line) => line.includes("idempotency_records_scrubbed"));
  assert.equal(scrubbed.length, 1, `one line says the records were scrubbed: ${JSON.stringify(lines.filter((l) => l.includes("idempotency")))}`);
  assert.match(scrubbed[0], /count=1/);
  assert.ok(!lines.some((line) => line.includes(key)), "no log line holds the key");
  const replay = await again.api("POST", "/triggers", body, { "idempotency-key": "older-key" });
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  assert.equal(replay.headers.get("idempotent-replayed"), "true", "the older record still replays");
  assert.ok(!JSON.stringify(replay.body).includes(key), "its replay holds no key");
  const other = await again.api("POST", "/triggers", dealTrigger(fakeKey()), { "idempotency-key": "older-key" });
  assert.equal(other.status, 409, "another body under the older key is still a mismatch");
});

test("a template's composio trigger whose key comes from a parameter: no file under the data directory holds the key", async (t) => {
  const root = await keyPackage(t);
  const composio = await startFakeComposio({ toolkits: { hubspot: { no_auth: false, tools: TOOLS } }, authConfigs: { hubspot: [{ id: "ac_managed", is_composio_managed: true }] }, active: ["hubspot"], triggerTypes: { hubspot: [DEAL_STAGE] } });
  t.after(() => composio.close());
  const server = await serve(t, { templates: root, publicUrl: PUBLIC, composioControl: { baseUrl: composio.baseUrl } });
  const saved = await server.api("PUT", "/settings/mcp-servers/work-hubspot/composio", { api_key: composio.apiKey, toolkit: "hubspot", tools: ["HUBSPOT_LIST_DEALS"], user_id: "agentrun-qa" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const key = fakeKey();
  const applied = await server.api("POST", "/templates/deals/apply", { parameters: { app_id: "4242", developer_api_key: key } }, { "idempotency-key": "deals-files" });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const holding = filesUnder(server.data).filter((path) => readFileSync(path).includes(key));
  assert.deepEqual(holding, [], "no file under the data directory holds the key in the clear");
});

test("a create whose config has a credential-named string below its top level is refused 422, in plain words, before Composio is asked anything", async (t) => {
  const s = await setup(t);
  for (const config of [{ app_id: "4242", auth: { api_key: fakeKey() } }, { app_id: "4242", credentials: { user: "u", pass: fakeKey() } }, { app_id: "4242", headers: [{ authorization: fakeKey() }] }]) {
    const key = JSON.stringify(config).match(/fake-hubspot-dev-[0-9a-f]+/)[0];
    const res = await s.api("POST", "/triggers", { ...dealTrigger(key), source: { ...dealTrigger(key).source, config } });
    assert.equal(res.status, 422, `a nested credential is refused: ${JSON.stringify(res.body)}`);
    assert.match(res.body.error.fields[0].field, /^source\.config\./);
    assert.match(res.body.error.fields[0].message, /top level/);
    assert.ok(!JSON.stringify(res.body).includes(key), "the refusal holds no key");
  }
  assert.equal(s.composio.instances.size, 0, "nothing made on Composio");
  assert.ok(!s.lines.some((l) => /fake-hubspot-dev-/.test(l)), "no log line holds a key");
});

test("a trigger an earlier server kept with a credential below the config's top level: masked at any depth on reads, sealed by JSON Pointer at the next start, and gone with the delete", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const inner = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  const { sealed_config: _, ...source } = made.body.source;
  await s.server.store.triggers.update(made.body.id, { source: { ...source, config: { app_id: "4242", developer_api_key: key, extra: { client_secret: inner, region: "eu" } } } });
  const one = await s.api("GET", `/triggers/${made.body.id}`);
  assert.ok(![key, inner].some((k) => JSON.stringify(one.body).includes(k)), "GET masks a credential at any depth");
  assert.equal(one.body.source.config.extra.client_secret, MASK);
  assert.equal(one.body.source.config.extra.region, "eu", "a field that names no secret is answered as kept");
  assert.deepEqual([...one.body.source.sealed_config].sort(), ["/extra/client_secret", "developer_api_key"], "a nested one is named by its JSON Pointer");
  await s.server.stop();
  const lines = [];
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl }, log: (line) => lines.push(line) });
  assert.equal((await sealedRowsOf(again.store, made.body.id)).length, 2, "both are sealed at the start");
  assert.deepEqual(filesUnder(again.data).filter((path) => [key, inner].some((k) => readFileSync(path).includes(k))), [], "no file under the data directory holds either");
  assert.ok(!lines.some((l) => [key, inner].some((k) => l.includes(k))), "no log line holds either");
  const read = await again.api("GET", `/triggers/${made.body.id}`);
  const renamed = await again.api("PATCH", `/triggers/${made.body.id}`, { name: "renamed", source: read.body.source });
  assert.equal(renamed.status, 200, `the source sent back as read is no change: ${JSON.stringify(renamed.body)}`);
  const gone = await again.api("DELETE", `/triggers/${made.body.id}`);
  assert.ok(gone.status === 204 || gone.status === 200, JSON.stringify(gone.body));
  assert.equal((await sealedRowsOf(again.store, made.body.id)).length, 0, "the delete removes both");
});

test("a PATCH to a trigger an earlier server kept with a credential below the config's top level: leaving it out keeps it, and so does its mask; a changed field or another value is still refused", async (t) => {
  const s = await setup(t);
  const key = fakeKey();
  const inner = fakeKey();
  const escaped = fakeKey();
  const other = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  const { sealed_config: _, ...source } = made.body.source;
  // One nested key under a plain object, one under keys a JSON Pointer escapes ("~" as ~0, "/" as ~1).
  await s.server.store.triggers.update(made.body.id, { source: { ...source, config: { app_id: "4242", developer_api_key: key, auth: { api_key: inner, region: "eu" }, "x~y": { "api/token": escaped } } } });
  await s.server.stop();
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl } });
  assert.deepEqual([...(await again.api("GET", `/triggers/${made.body.id}`)).body.source.sealed_config].sort(), ["/auth/api_key", "/x~0y/api~1token", "developer_api_key"]);
  const patch = (config) => again.api("PATCH", `/triggers/${made.body.id}`, { source: { kind: "composio", server: "hs", event: DEAL_STAGE.slug, config } });
  // (a) Each sealed key left out, its parent object sent.
  const left = await patch({ app_id: "4242", auth: { region: "eu" }, "x~y": {} });
  assert.equal(left.status, 200, `a PATCH that leaves a nested sealed key out keeps it: ${JSON.stringify(left.body)}`);
  const read = await again.api("GET", `/triggers/${made.body.id}`);
  assert.equal(read.body.source.config.auth.api_key, MASK, "the nested key is still answered [sealed] at its place");
  assert.equal(read.body.source.config["x~y"]["api/token"], MASK);
  assert.equal(read.body.source.config.auth.region, "eu");
  assert.equal((await sealedRowsOf(again.store, made.body.id)).length, 3, "every sealed value is kept");
  // (b) Each sent back as its mask.
  const masked = await patch({ app_id: "4242", developer_api_key: MASK, auth: { api_key: MASK, region: "eu" }, "x~y": { "api/token": MASK } });
  assert.equal(masked.status, 200, `the nested mask sent back keeps it: ${JSON.stringify(masked.body)}`);
  // (c) A changed field beside it, or another value in its place, is a change to the config.
  for (const config of [{ app_id: "4242", auth: { region: "us" }, "x~y": {} }, { app_id: "4242", auth: { api_key: other, region: "eu" }, "x~y": {} }]) {
    const res = await patch(config);
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.equal(res.body.error.fields[0].field, "source.config");
    assert.equal(res.body.error.fields[0].reason, "not_allowed");
    assert.ok(![key, inner, escaped, other].some((one) => JSON.stringify(res.body).includes(one)), "the refusal holds no key");
  }
  assert.equal((await sealedRowsOf(again.store, made.body.id)).length, 3, "a refused PATCH changes nothing");
});

test("a refusal of Composio's that quotes the config as JSON, a sealed value holding a quote and a backslash: the answer and the log hold neither its raw nor its escaped form, and say Composio's words were withheld", async (t) => {
  const core = `fake-hubspot-dev-${randomBytes(10).toString("hex")}`;
  const key = `${core}"q\\b`;
  const config = { app_id: "4242", developer_api_key: key };
  const s = await setup(t, { composio: { fail: { path: "/upsert", status: 400, body: { error: { message: `Invalid trigger config: ${JSON.stringify(config)}` } } } } });
  const res = await s.api("POST", "/triggers", { ...dealTrigger(key), source: { ...dealTrigger(key).source, config } });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  const said = JSON.stringify(res.body);
  assert.ok(!said.includes(core), "the refusal's answer holds no form of the value");
  assert.match(res.body.error.fields[0].message, /\(HTTP 400\)/, "the step's status, in this server's words");
  assert.match(res.body.error.fields[0].message, /withheld/, "Composio's own words are withheld");
  assert.ok(!s.lines.some((l) => l.includes(core)), "no log line holds any form of the value");
});

test("a call that carries only the key: a refusal quoting the key JSON-escaped or percent-encoded holds no form of it", async (t) => {
  const core = `fake-composio-${randomBytes(10).toString("hex")}`;
  const apiKey = `${core}"q\\b+=/`;
  const composio = await startFakeComposio({ apiKey, toolkits: { hubspot: { no_auth: false, tools: TOOLS } }, fail: { path: "/toolkits/hubspot", status: 400, body: { error: { message: `bad key ${JSON.stringify(apiKey)} at ?api_key=${encodeURIComponent(apiKey)}` } } } });
  t.after(() => composio.close());
  const server = await serve(t, { composioControl: { baseUrl: composio.baseUrl } });
  const res = await server.api("PUT", "/settings/mcp-servers/hs/composio", { api_key: apiKey, toolkit: "hubspot", tools: ["HUBSPOT_LIST_DEALS"], user_id: "agentrun-qa" });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.ok(!JSON.stringify(res.body).includes(core), `the refusal holds no form of the key: ${JSON.stringify(res.body)}`);
  assert.match(res.body.error.fields[0].message, /\[the key\]/, "the key's place is said");
});

test("an Idempotency-Key replay of a run create gives back its input as sent, a nested {kind: composio, config} in it too; a trigger create's replay is still masked", async (t) => {
  const s = await setup(t);
  const input = { content: "inspect", item: { kind: "composio", config: { token: "example" } } };
  const first = await s.api("POST", "/agents/triage/runs", { input }, { "idempotency-key": "run-nested" });
  assert.ok([201, 202].includes(first.status), JSON.stringify(first.body));
  const replay = await s.api("POST", "/agents/triage/runs", { input }, { "idempotency-key": "run-nested" });
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  assert.equal(JSON.stringify(replay.body.input), JSON.stringify(first.body.input), "the replay's input is byte for byte the first answer's");
  assert.deepEqual(replay.body.input, input, "and it is the input as sent");
  const record = JSON.parse(readFileSync(join(s.server.data, ".idempotency.json"), "utf8"));
  const [, kept] = record.entries.find(([slot]) => slot.endsWith("\nrun-nested"));
  assert.equal(kept.answer.body.input.item.config.token, "example", "the record keeps the run's input as sent");
  const body = dealTrigger(fakeKey());
  const made = await s.api("POST", "/triggers", body, { "idempotency-key": "deal-still" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const again = await s.api("POST", "/triggers", body, { "idempotency-key": "deal-still" });
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(again.body.source.config.developer_api_key, MASK, "the trigger create's replay is masked");
  assert.equal(again.body.id, made.body.id);
});

/** The store's rewrite marker (store/sqlite/store.ts secureRewrite): beside the database file, there while a rewrite's
 *  old bytes may still be in the store's files. */
const markerIn = (data) => join(data, "store.sqlite.scrub");

/** A server whose store holds trigger `id`'s key only in free pages: kept in the clear, rewritten by pauses, then masked
 *  with no scrub after, as a server that died after its rewrite committed leaves it. Its marker is left. */
async function diedAfterRewrite(t) {
  const s = await setup(t);
  const key = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  await keptInTheClear(s.server.store, made.body, key);
  await livedWith(s.api, made.body.id);
  const masked = (await s.api("GET", `/triggers/${made.body.id}`)).body.source;
  await s.server.store.triggers.update(made.body.id, { source: masked });
  await s.server.stop();
  writeFileSync(markerIn(s.server.data), "");
  assert.ok(filesUnder(s.server.data).some((path) => readFileSync(path).includes(key)), "the key's old bytes are in the store's free space before the start");
  return { s, key, made };
}

test("a rewrite marker left by a server that died after the rewrite committed: the next start clears the old bytes and the marker, though no row is in the clear", async (t) => {
  const { s, key } = await diedAfterRewrite(t);
  const lines = [];
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl }, log: (line) => lines.push(line) });
  assert.deepEqual(filesUnder(again.data).filter((path) => readFileSync(path).includes(key)), [], "the start's scrub leaves no copy of the key in any file under the data directory");
  assert.equal(existsSync(markerIn(again.data)), false, "the marker is cleared once the checkpoint is done");
  assert.ok(!lines.some((l) => l.includes(key)), "no log line holds the key");
});

test("a busy checkpoint (a reader in another connection holds the log) keeps the marker and says so by code, and the next start finishes the scrub", async (t) => {
  const { s, key } = await diedAfterRewrite(t);
  // Another process's reader: a read transaction held open on the store across the start.
  const reader = new DatabaseSync(join(s.server.data, "store.sqlite"), { readOnly: true });
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) FROM sqlite_schema").get();
  const lines = [];
  let held;
  try {
    held = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl }, log: (line) => lines.push(line) });
  } finally {
    reader.exec("COMMIT");
    reader.close();
  }
  const said = lines.filter((l) => l.includes("store_scrub_not_done"));
  assert.equal(said.length, 1, `a busy checkpoint is said: ${JSON.stringify(lines.filter((l) => l.includes("store")))}`);
  assert.match(said[0], /reason=busy/);
  assert.ok(!lines.some((l) => l.includes(key)), "no log line holds the key");
  assert.equal(existsSync(markerIn(held.data)), true, "the marker stays for the next start");
  await held.stop();
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl } });
  assert.deepEqual(filesUnder(again.data).filter((path) => readFileSync(path).includes(key)), [], "the next start finishes the scrub");
  assert.equal(existsSync(markerIn(again.data)), false, "and clears the marker");
});

/** A store opened with a short busy wait (200 ms), and another connection holding its write lock. */
async function storeHeld(t) {
  const { openSqliteStore } = await import("../dist/store/index.js");
  const dataDir = join(await scratch(t), "agents");
  const store = await openSqliteStore({ dataDir, busyTimeoutMs: 200 });
  const holder = new DatabaseSync(join(dataDir, "store.sqlite"));
  holder.exec("BEGIN IMMEDIATE");
  t.after(async () => {
    if (holder.isTransaction) holder.exec("ROLLBACK");
    holder.close();
    await store.close().catch(() => undefined);
  });
  return { store, holder, marker: join(dataDir, "store.sqlite.scrub") };
}

test("the scrub's VACUUM, the write lock held past the store's busy wait and let go before its one retry: it waits, tries again and the scrub is done", async (t) => {
  const { store, holder, marker } = await storeHeld(t);
  // Let go after the first try's busy wait (200 ms) has run out, and before the retry (about 400 ms after it).
  const timer = setTimeout(() => holder.isOpen && holder.isTransaction && holder.exec("COMMIT"), 450);
  t.after(() => clearTimeout(timer));
  const done = await store.secureRewrite(async () => 1);
  assert.deepEqual(done, { rewritten: 1 }, "the retry runs the scrub through");
  assert.equal(existsSync(marker), false, "and clears the marker");
});

test("the scrub's VACUUM, the write lock never let go: one retry, then the marker is kept and the rewrite says busy", async (t) => {
  const { store, marker } = await storeHeld(t);
  const done = await store.secureRewrite(async () => 1);
  assert.deepEqual(done, { rewritten: 1, left: "busy" }, "a lock held through the retry is said as busy");
  assert.equal(existsSync(marker), true, "the marker stays for the next start");
});

test("a count named after a credential is no credential: max_tokens, token_count, token_limit and their kin stay as they are, a number in one too; access_token, token, api_tokens, refresh_token, token_secret and bot_token are sealed", async () => {
  const composio = await import("../dist/trigger-composio.js");
  const counts = ["max_tokens", "maxTokens", "min_tokens", "num_tokens", "token_count", "token_limit", "tokens_used", "token_budget", "tokens_remaining", "total_tokens", "tokens_per_minute", "token_usage", "password_min_length"];
  const sealed = ["access_token", "token", "api_tokens", "refresh_token", "token_secret", "bot_token", "budget_api_key", "max_api_key"];
  const config = Object.fromEntries([...counts, ...sealed].map((name) => [name, `value-of-${name}`]));
  assert.deepEqual(composio.sealedConfigFields(config).sort(), [...sealed].sort(), "a credential's word beside a count's word names a count; elsewhere it names a credential");
  assert.deepEqual(composio.sealedConfigFields({ max_tokens: 4096, token_count: 12345678901, access_token: fakeKey() }), ["access_token"], "a number in a count-shaped field is not sealed");
  assert.deepEqual(composio.configSecrets({ limits: { max_tokens: 4096 } }), [], "nor below the top level");
});

/** An http(s) address carrying a credential: a password in its userinfo, or a query parameter named like one. */
function secretUrl(kind, secret) {
  const url = new URL("https://hooks.example.com/feed");
  if (kind === "userinfo") {
    url.username = "deals";
    url.password = secret;
  } else url.searchParams.set(kind, secret);
  return url.href;
}

test("a config value that is an address with a credential in it (a password in its userinfo, or ?token=, ?api_key=, ?access_token=, ?sig=) is sealed whatever its field's name; an address with neither stays", async (t) => {
  const composio = await import("../dist/trigger-composio.js");
  const config = { plain: "https://hooks.example.com/feed?page=2", userinfo: secretUrl("userinfo", fakeKey()), token: secretUrl("token", fakeKey()), api_key_q: secretUrl("api_key", fakeKey()), access: secretUrl("access_token", fakeKey()), signed: secretUrl("sig", fakeKey()), name_only: "https://deals@hooks.example.com/feed" };
  const fields = Object.fromEntries(Object.entries(config).map(([name, value]) => [name === "token" ? "feed_a" : name === "api_key_q" ? "feed_b" : name, value]));
  // A user part alone is sealed too: it may be a token (https://TOKEN@host), and the rule can't tell a name from one.
  assert.deepEqual(composio.sealedConfigFields(fields).sort(), ["access", "feed_a", "feed_b", "name_only", "signed", "userinfo"], "each address carrying a credential, or a user part alone, is sealed whole; the plain one is not");
  const s = await setup(t);
  const key = fakeKey();
  const secret = fakeKey();
  const made = await s.api("POST", "/triggers", { ...dealTrigger(key), source: { kind: "composio", server: "hs", event: DEAL_STAGE.slug, config: { app_id: "4242", developer_api_key: key, callback: "https://hooks.example.com/feed", feed: secretUrl("token", secret) } } });
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  assert.equal(made.body.source.config.feed, MASK, "a create seals an address that carries a credential");
  assert.equal(made.body.source.config.callback, "https://hooks.example.com/feed", "and leaves a plain one");
  assert.deepEqual([...made.body.source.sealed_config].sort(), ["developer_api_key", "feed"]);
  assert.equal([...s.composio.instances.values()][0].trigger_config.feed, secretUrl("token", secret), "Composio gets the address whole");
  assert.ok(![...s.answers, ...s.lines].some((one) => one.includes(secret)), "no answer or log line holds its credential");
  const nested = await s.api("POST", "/triggers", { ...dealTrigger(fakeKey()), source: { kind: "composio", server: "hs", event: DEAL_STAGE.slug, config: { app_id: "4242", developer_api_key: fakeKey(), hooks: { feed: secretUrl("userinfo", fakeKey()) } } } });
  assert.equal(nested.status, 422, JSON.stringify(nested.body));
  assert.equal(nested.body.error.fields[0].field, "source.config.hooks.feed", "one below the top level is refused, as a credential there is");
});

test("an address with a credential an earlier server kept below the config's top level: masked on reads, sealed at the next start with no file holding it, and a PATCH that leaves it out keeps it", async (t) => {
  const s = await setup(t);
  const secret = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(fakeKey()));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  await s.server.store.triggers.update(made.body.id, { source: { ...made.body.source, config: { app_id: "4242", developer_api_key: MASK, hooks: { feed: secretUrl("userinfo", secret), region: "eu" } } } });
  await livedWith(s.api, made.body.id);
  const one = await s.api("GET", `/triggers/${made.body.id}`);
  assert.ok(!JSON.stringify(one.body).includes(secret), `GET masks an address that carries a credential: ${JSON.stringify(one.body.source.config)}`);
  assert.equal(one.body.source.config.hooks.feed, MASK);
  await s.server.stop();
  const lines = [];
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl }, log: (line) => lines.push(line) });
  assert.ok((await sealedRowsOf(again.store, made.body.id)).some((row) => row.scope === `config:${made.body.id}:${encodeURIComponent("/hooks/feed")}`), "sealed at the start by its JSON Pointer");
  assert.deepEqual(filesUnder(again.data).filter((path) => readFileSync(path).includes(secret)), [], "no file under the data directory holds it once the start sealed it");
  assert.ok(!lines.some((l) => l.includes(secret)), "no log line holds it");
  const left = await again.api("PATCH", `/triggers/${made.body.id}`, { source: { kind: "composio", server: "hs", event: DEAL_STAGE.slug, config: { app_id: "4242", hooks: { region: "eu" } } } });
  assert.equal(left.status, 200, `a PATCH that leaves it out keeps it: ${JSON.stringify(left.body)}`);
});

/** Waits up to 10 s for a line of `lines` that `match` takes, and answers it (undefined when none came). */
async function lineOf(lines, match) {
  for (let waited = 0; waited < 10_000; waited += 50) {
    const found = lines.find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

/** A FORM_EVENT trigger an earlier server kept with `hub_value`, a field only the event's schema marks, in the clear. */
async function keptUnmarked(t) {
  const s = await setup(t, { composio: { triggerTypes: { hubspot: [DEAL_STAGE, FORM_EVENT] } } });
  const value = fakeKey();
  const made = await s.api("POST", "/triggers", { ...dealTrigger(""), source: { kind: "composio", server: "hs", event: FORM_EVENT.slug, config: { app_id: "4242", region: "eu" } } });
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  await s.server.store.triggers.update(made.body.id, { source: { ...made.body.source, config: { app_id: "4242", region: "eu", hub_value: value } } });
  assert.equal((await s.api("GET", `/triggers/${made.body.id}`)).body.source.config.hub_value, value, "before the start, its name alone says nothing");
  await s.server.stop();
  return { s, value, id: made.body.id };
}

test("a trigger an earlier server kept with a field only its event's schema marks (format: password) in the clear is sealed after the next start, the schema read once from Composio, and no file holds it", async (t) => {
  const { s, value, id } = await keptUnmarked(t);
  const lines = [];
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl }, log: (line) => lines.push(line) });
  const said = await lineOf(lines, (l) => l.includes("composio_config_sealed") && l.includes(id) && l.includes("hub_value"));
  assert.ok(said, `the start seals a field its event's schema marks, after the start: ${JSON.stringify(lines.filter((l) => l.includes("composio")))}`);
  const read = await again.api("GET", `/triggers/${id}`);
  assert.equal(read.body.source.config.hub_value, MASK);
  assert.ok(read.body.source.sealed_config.includes("hub_value"));
  assert.equal(s.composio.calls.filter((call) => call.method === "GET" && call.path === `/api/v3/triggers_types/${FORM_EVENT.slug}`).length >= 1, true, "the event's schema is read from Composio");
  assert.ok(!lines.some((l) => l.includes(value)), "no log line holds it");
  // No VACUUM while serving (it would hold every store call and a runner's writes, and needs the store's size again on
  // disk): the rewrite runs with secure_delete on and leaves the marker, and the next start scrubs before it serves.
  const deferred = await lineOf(lines, (l) => l.includes("store_scrub_not_done"));
  assert.match(deferred ?? "", /reason=deferred/, `while serving, the scrub is left to the next start: ${JSON.stringify(lines.filter((l) => l.includes("store")))}`);
  assert.equal(existsSync(markerIn(again.data)), true, "the marker is left for the next start");
  await again.stop();
  const third = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl } });
  assert.deepEqual(filesUnder(third.data).filter((path) => readFileSync(path).includes(value)), [], "the next start's scrub leaves no file under the data directory holding it");
  assert.equal(existsSync(markerIn(third.data)), false, "and clears the marker");
});

test("an address in any scheme that carries a credential is sealed whole: a password, a user part alone, a credential-named query or fragment parameter; one with none stays as it is", async () => {
  const composio = await import("../dist/trigger-composio.js");
  const secret = fakeKey();
  const carrying = [
    `postgres://app:${secret}@db.example.com:5432/main`,
    `redis://:${secret}@cache.example.com:6379/0`,
    `amqp://app:${secret}@mq.example.com/vhost`,
    `mongodb+srv://app:${secret}@cluster0.example.net/main?retryWrites=true`,
    `mongodb://app:${secret}@h1.example.com:27017,h2.example.com:27017/main`,
    `https://${secret}@github.com/acme/repo.git`,
    `https://hooks.example.com/callback#access_token=${secret}&state=x`,
  ];
  const plain = ["postgres://db.example.com:5432/main", "https://hooks.example.com/feed?page=2", "https://hooks.example.com/docs#section-2", "not an address", "mailto:someone"];
  for (const value of carrying) assert.equal(composio.credentialUrl(value), true, `carries a credential: ${value.replace(secret, "<secret>")}`);
  for (const value of plain) assert.equal(composio.credentialUrl(value), false, `carries none: ${value}`);
  const config = { database_url: carrying[0], feed: plain[1], nested: { mongo_uri: carrying[4] } };
  assert.deepEqual(composio.sealedConfigFields(config), ["database_url"], "sealed at the top level whatever the field's name");
  assert.deepEqual(composio.configSecrets(config).map((found) => found.name).sort(), ["/nested/mongo_uri", "database_url"], "and found at any depth in a trigger an earlier server kept");
});

test("an address whose password holds a raw '/', '?' or '#' is sealed: any scheme:// with an '@' before whitespace", async () => {
  const composio = await import("../dist/trigger-composio.js");
  const secret = fakeKey();
  const carrying = [`mongodb://u:pa/ss${secret}@h.example.com/main`, `postgres://u:pa?ss${secret}@db.example.com/main`, `redis://:pa#ss${secret}@cache.example.com:6379`, `amqp://u:${secret}/x?y#z@mq.example.com`];
  for (const value of carrying) assert.equal(composio.credentialUrl(value), true, `carries a credential: ${value.replace(secret, "<secret>")}`);
  // No '@' after scheme:// before whitespace: nothing to seal.
  for (const value of ["https://hooks.example.com/a/b?page=2#top", "postgres://db.example.com/main", "see https://example.com then mail a@b.example.com"]) assert.equal(composio.credentialUrl(value), false, `carries none: ${value}`);
});

test("a PATCH carrying a source that read the trigger before the after-start seal wrote it never writes the clear value back: it is checked again on the sealed row", async (t) => {
  const { s, value, id, raced: hit } = await raced(t, (row) => ({ source: { ...row.source, config: { ...row.source.config, hub_value: MASK }, sealed_config: ["hub_value"] } }));
  // The source as the PATCH read it (before the seal): the value in the clear, as an answer showed it then.
  const res = await s.api("PATCH", `/triggers/${id}`, { name: "renamed", source: { kind: "composio", server: "hs", event: FORM_EVENT.slug, config: { app_id: "4242", region: "eu", hub_value: value } } });
  assert.ok(hit(), "the seal was written between the PATCH's read and its write");
  assert.notEqual(res.status, 200, `a PATCH read before the seal is not written over it: ${JSON.stringify(res.body).replace(value, "<value>")}`);
  assert.ok(!JSON.stringify(res.body).includes(value), "its answer holds no value");
  const read = await s.api("GET", `/triggers/${id}`);
  assert.equal(read.body.source.config.hub_value, MASK, "the trigger stays masked");
  assert.deepEqual(read.body.source.sealed_config, ["hub_value"], "and sealed");
  assert.equal(read.body.name, "form", "nothing of the PATCH written");
});

test("a PATCH carrying a source that read the trigger before the after-start seal wrote it in the same millisecond never writes the clear value back: the seal changed the source, whatever the updatedAt", async (t) => {
  const { s, value, id, raced: hit } = await raced(t, (row) => ({ source: { ...row.source, config: { ...row.source.config, hub_value: MASK }, sealed_config: ["hub_value"] } }), { sameMs: true });
  const res = await s.api("PATCH", `/triggers/${id}`, { name: "renamed", source: { kind: "composio", server: "hs", event: FORM_EVENT.slug, config: { app_id: "4242", region: "eu", hub_value: value } } });
  assert.ok(hit(), "the seal was written between the PATCH's read and its write, in the millisecond it read");
  assert.notEqual(res.status, 200, `a PATCH read before a same-millisecond seal is not written over it: ${JSON.stringify(res.body).replace(value, "<value>")}`);
  assert.ok(!JSON.stringify(res.body).includes(value), "its answer holds no value");
  const read = await s.api("GET", `/triggers/${id}`);
  assert.equal(read.body.source.config.hub_value, MASK, "the trigger stays masked");
  assert.equal(read.body.name, "form", "nothing of the PATCH written");
});

test("a PATCH carrying a source on a trigger another write changed meanwhile (its next time) is checked again on the row as it is now, and written", async (t) => {
  const { s, id, raced: hit } = await raced(t, () => ({ nextAt: null }));
  const before = (await s.api("GET", `/triggers/${id}`)).body;
  const res = await s.api("PATCH", `/triggers/${id}`, { name: "renamed", source: before.source });
  assert.ok(hit(), "another write landed between the PATCH's read and its write");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.name, "renamed");
  assert.equal((await s.api("GET", `/triggers/${id}`)).body.name, "renamed");
});

/** A Composio trigger kept with a field only its event's schema marks, in the clear, and a store whose next trigger
 *  write that carries a source is preceded by `meanwhile(row)`'s write (another writer's, after the PATCH read it). */
async function raced(t, meanwhile, { sameMs = false } = {}) {
  // The server's own trigger store, handed to it (as serve() hands one), its update wrapped: the PATCH's write is the one
  // seen, and the seal is written between the PATCH's read and that write. (server.store is the test's own handle on the
  // data directory, which the server never writes through.) sameMs: the store's clock held, for that write, at the
  // updatedAt the PATCH read, as two writes in one millisecond are.
  let held;
  const base = await triggerStore(undefined, { now: () => held ?? Date.now() });
  let once = false;
  let racing;
  const triggersSeen = new Proxy(base.triggers, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "update") return typeof value === "function" ? value.bind(target) : value;
      return async (id, patch, ...rest) => {
        if (racing && !once && id === racing && patch?.source) {
          once = true;
          await new Promise((r) => setTimeout(r, 5));
          const row = await target.get(id);
          if (sameMs) held = row.updatedAt;
          await value.call(target, id, meanwhile(row));
          held = undefined;
          if (sameMs) assert.equal((await target.get(id)).updatedAt, row.updatedAt, "the write meanwhile kept the updatedAt the PATCH read");
          await new Promise((r) => setTimeout(r, 5));
        }
        return value.call(target, id, patch, ...rest);
      };
    },
  });
  const s = await setup(t, { server: { store: { ...base, triggers: triggersSeen } }, composio: { triggerTypes: { hubspot: [DEAL_STAGE, FORM_EVENT] } } });
  const value = fakeKey();
  const made = await s.api("POST", "/triggers", { ...dealTrigger(""), name: "form", source: { kind: "composio", server: "hs", event: FORM_EVENT.slug, config: { app_id: "4242", region: "eu" } } });
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  const kept = await base.triggers.get(made.body.id);
  await base.triggers.update(made.body.id, { source: { ...kept.source, config: { ...kept.source.config, hub_value: value } } });
  racing = made.body.id;
  return { s, value, id: made.body.id, raced: () => once };
}

test("a trigger update given the updatedAt it was read at: refused (undefined, nothing written) once the trigger changed or went; written while it is the same", async (t) => {
  const s = await setup(t);
  const made = await s.api("POST", "/triggers", dealTrigger(fakeKey()));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  const store = s.server.store;
  const read = await store.triggers.get(made.body.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await store.triggers.update(made.body.id, { name: "renamed meanwhile" });
  const stale = await store.triggers.update(made.body.id, { name: "from a stale read" }, undefined, { ifUpdatedAt: read.updatedAt });
  assert.equal(stale, undefined, "an update on a stale read is refused");
  assert.equal((await store.triggers.get(made.body.id)).name, "renamed meanwhile", "and writes nothing");
  const fresh = await store.triggers.get(made.body.id);
  const written = await store.triggers.update(made.body.id, { name: "on a fresh read" }, undefined, { ifUpdatedAt: fresh.updatedAt });
  assert.equal(written?.name, "on a fresh read", "an update on the current read is written");
  await store.triggers.remove(made.body.id);
  assert.equal(await store.triggers.update(made.body.id, { name: "gone" }, undefined, { ifUpdatedAt: written.updatedAt }), undefined, "and one on a trigger since deleted is refused");
});

test("a trigger update given the updatedAt and source it was read at: refused once another write changed its source, even in the same millisecond (one updatedAt); written while both are the same", async (t) => {
  const store = await triggerStore(undefined, { now: () => 1_800_000_000_000 });
  const s = await setup(t, { server: { store } });
  const made = await s.api("POST", "/triggers", dealTrigger(fakeKey()));
  assert.equal(made.status, 201, made.status === 201 ? "" : JSON.stringify(made.body));
  const read = await store.triggers.get(made.body.id);
  await store.triggers.update(made.body.id, { source: { ...read.source, config: { ...read.source.config, region: "eu" } } });
  assert.equal((await store.triggers.get(made.body.id)).updatedAt, read.updatedAt, "the write meanwhile kept the same updatedAt (one millisecond)");
  const stale = await store.triggers.update(made.body.id, { source: read.source }, undefined, { ifUpdatedAt: read.updatedAt, ifSource: read.source });
  assert.equal(stale, undefined, "a source write on a stale read in the same millisecond is refused");
  assert.equal((await store.triggers.get(made.body.id)).source.config.region, "eu", "and writes nothing");
  const fresh = await store.triggers.get(made.body.id);
  const written = await store.triggers.update(made.body.id, { name: "on a fresh read" }, undefined, { ifUpdatedAt: fresh.updatedAt, ifSource: fresh.source });
  assert.equal(written?.name, "on a fresh read", "an update on the current read is written");
});

test("the after-start seal's rewrite refused because its trigger changed or went meanwhile: the values it sealed for that trigger are removed again, and the log says so without them", async (t) => {
  const { ComposioTriggers } = await import("../dist/composio-triggers.js");
  const composio = await startFakeComposio({ triggerTypes: { hubspot: [FORM_EVENT] } });
  t.after(() => composio.close());
  const value = fakeKey();
  const holder = { id: "trg_race", name: "race", enabled: true, updatedAt: 1000, source: { kind: "composio", server: "hs", event: FORM_EVENT.slug, config: { app_id: "4242", region: "eu", hub_value: value }, instance_id: "ti_race", hook: "cph_race" } };
  const rows = new Map();
  const said = [];
  const triggers = new ComposioTriggers({
    control: { baseUrl: composio.baseUrl },
    sealed: { get: (scope, field) => rows.get(scope)?.[field], set: async (scope, field, given) => void rows.set(scope, { [field]: given }), remove: async (scope) => void rows.delete(scope) },
    credential: async () => ({ key: composio.apiKey, user: "agentrun-qa", toolkit: "hubspot" }),
    holders: async () => [holder],
    say: (fields) => said.push(fields),
  });
  const asked = [];
  await triggers.sealMarked(async (id, _source, updatedAt, read) => {
    asked.push({ id, updatedAt, read, sealed: [...rows.keys()] });
    return false;
  }, (work) => work());
  assert.deepEqual(asked, [{ id: "trg_race", updatedAt: 1000, read: holder.source, sealed: [`config:trg_race:hub_value`] }], "the rewrite is asked on the updatedAt and the source the trigger was read at (a write in the same millisecond shares the one, never the other), its value sealed first");
  assert.equal(rows.size, 0, "a refused rewrite leaves no sealed value behind for the trigger");
  assert.ok(said.some((f) => f.condition === "composio_config_not_sealed" && f.trigger === "trg_race"), `said: ${JSON.stringify(said.map((f) => f.condition))}`);
  assert.ok(!said.some((f) => f.condition === "composio_config_sealed"), "never said as sealed");
  assert.ok(!JSON.stringify(said).includes(value), "no line holds the value");
});

test("a create answer kept under an Idempotency-Key with a field only its event's schema marks in the clear: once the after-start seal seals the field, the record is masked too, and its replay holds no value", async (t) => {
  const { s, value, id } = await keptUnmarked(t);
  // The record as a server before the schema seal kept it: the create's answer with the field in the clear.
  const body = { name: "form", source: { kind: "composio", server: "hs", event: FORM_EVENT.slug, config: { app_id: "4242", region: "eu", hub_value: value } } };
  const answer = { status: 201, body: { id, ...body }, headers: { location: `/v2/triggers/${id}` } };
  const { stable } = await import("../dist/validate.js");
  writeFileSync(join(s.server.data, ".idempotency.json"), JSON.stringify({ version: 1, entries: [[`/triggers\nform-key`, { fingerprint: stable(body), at: Date.now(), answer }]] }), { mode: 0o600 });
  const lines = [];
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl }, log: (line) => lines.push(line) });
  assert.ok(await lineOf(lines, (l) => l.includes("composio_config_sealed") && l.includes(id)), `sealed after the start: ${JSON.stringify(lines.filter((l) => l.includes("composio")))}`);
  assert.ok(!readFileSync(join(again.data, ".idempotency.json"), "utf8").includes(value), "the record no longer holds the value");
  const replay = await again.api("POST", "/triggers", body, { "idempotency-key": "form-key" });
  assert.equal(replay.headers.get("idempotent-replayed"), "true", "the record still replays");
  assert.ok(!JSON.stringify(replay.body).includes(value), `its replay holds no value: ${JSON.stringify(replay.body.source?.config)}`);
  assert.equal(replay.body.source.config.hub_value, MASK);
});

test("a cached create answer that cannot be saved masked (the file's write fails) once the after-start seal wrote the trigger: the trigger stays sealed with its value kept, the failed save is said by a code, the replay is masked, and the next save writes the record masked", async (t) => {
  const { s, value, id } = await keptUnmarked(t);
  const body = { name: "form", source: { kind: "composio", server: "hs", event: FORM_EVENT.slug, config: { app_id: "4242", region: "eu", hub_value: value } } };
  const answer = { status: 201, body: { id, ...body }, headers: { location: `/v2/triggers/${id}` } };
  const { stable } = await import("../dist/validate.js");
  writeFileSync(join(s.server.data, ".idempotency.json"), JSON.stringify({ version: 1, entries: [[`/triggers\nform-key`, { fingerprint: stable(body), at: Date.now(), answer }]] }), { mode: 0o600 });
  // A directory where the save writes first: every save of the file fails until it goes.
  const partial = join(s.server.data, ".idempotency.json.partial");
  mkdirSync(partial);
  const lines = [];
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl }, log: (line) => lines.push(line) });
  const ended = await lineOf(lines, (l) => (l.includes("composio_config_sealed") || l.includes("composio_config_not_sealed")) && l.includes(id));
  assert.match(ended ?? "", /composio_config_sealed/, `a failed save of the cached answer does not undo a seal already written: ${JSON.stringify(lines.filter((l) => l.includes("composio") || l.includes("idempotency")))}`);
  const read = await again.api("GET", `/triggers/${id}`);
  assert.equal(read.body.source.config.hub_value, MASK, "the trigger stays masked");
  const { bootSealKey } = await import("../dist/seal-key.js");
  const { sealedSettingsOverStore } = await import("../dist/sealed-settings-store.js");
  const adapter = await import("../dist/trigger-composio.js");
  const seal = await bootSealKey(again.store, again.data, { role: "runner" });
  const settings = sealedSettingsOverStore(again.store, "composio", adapter.composio.settings, seal.key, () => undefined);
  await settings.load();
  assert.equal(settings.get(adapter.configScope(id, "hub_value"), adapter.CONFIG_SECRET), value, "its sealed value is kept");
  const failed = await lineOf(lines, (l) => l.includes("idempotency_not_saved"));
  assert.match(failed ?? "", /trigger=trg_/, `the failed save is said, naming the trigger: ${JSON.stringify(lines.filter((l) => l.includes("idempotency")))}`);
  assert.match(failed ?? "", /error=[A-Za-z_]+/, "by a code");
  assert.ok(!lines.some((l) => l.includes(value)), "no line holds the value");
  const replay = await again.api("POST", "/triggers", body, { "idempotency-key": "form-key" });
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  assert.equal(replay.body.source.config.hub_value, MASK, "the replay is masked");
  // Once the file can be written, the next save writes every kept record, this one masked.
  rmSync(partial, { recursive: true });
  assert.equal((await again.api("POST", "/triggers", { ...dealTrigger(""), name: "other", source: { ...body.source, config: { app_id: "4242", region: "eu" } } }, { "idempotency-key": "other-key" })).status, 201);
  const record = readFileSync(join(again.data, ".idempotency.json"), "utf8");
  assert.ok(record.includes("form-key"), "the record is still kept");
  assert.ok(!record.includes(value), "and saved without the value");
});

test("a cached create answer whose masked save failed before a restart: the next start masks it from its trigger's sealed fields before it serves, and its replay holds no value", async (t) => {
  const { s, value, id } = await keptUnmarked(t);
  const body = { name: "form", source: { kind: "composio", server: "hs", event: FORM_EVENT.slug, config: { app_id: "4242", region: "eu", hub_value: value } } };
  const answer = { status: 201, body: { id, ...body }, headers: { location: `/v2/triggers/${id}` } };
  const { stable } = await import("../dist/validate.js");
  const file = join(s.server.data, ".idempotency.json");
  writeFileSync(file, JSON.stringify({ version: 1, entries: [[`/triggers\nform-key`, { fingerprint: stable(body), at: Date.now(), answer }]] }), { mode: 0o600 });
  const partial = join(s.server.data, ".idempotency.json.partial");
  mkdirSync(partial);
  const lines = [];
  const first = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl }, log: (line) => lines.push(line) });
  assert.ok(await lineOf(lines, (l) => l.includes("composio_config_sealed") && l.includes(id)), `sealed: ${JSON.stringify(lines.filter((l) => l.includes("composio")))}`);
  assert.ok(await lineOf(lines, (l) => l.includes("idempotency_not_saved")), "its save failed");
  await first.stop();
  rmSync(partial, { recursive: true });
  assert.ok(readFileSync(file, "utf8").includes(value), "the failed save left the record as it was");
  // The trigger is sealed already, so no seal runs at this start: the record is checked against the trigger's own fields.
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl } });
  assert.ok(!readFileSync(join(again.data, ".idempotency.json"), "utf8").includes(value), "the start wrote the record masked before any request");
  const replay = await again.api("POST", "/triggers", body, { "idempotency-key": "form-key" });
  assert.equal(replay.headers.get("idempotent-replayed"), "true", "the record still replays");
  assert.equal(replay.body.source.config.hub_value, MASK, "its replay is masked");
  assert.ok(!JSON.stringify(replay.body).includes(value), "and holds no value");
});

test("a cached create answer whose trigger was deleted before a restart: the next start masks every field of its config before it serves (no trigger is left to say which are sealed), and its replay holds no value", async (t) => {
  const { s, value, id } = await keptUnmarked(t);
  // Composio down: no seal runs, so the delete finds the trigger in the clear, as a server before this one left it.
  await s.composio.close();
  const first = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl } });
  const deleted = await first.api("DELETE", `/triggers/${id}`);
  assert.ok([200, 204].includes(deleted.status), `deleted here (200 says what Composio kept): ${deleted.status}`);
  await first.stop();
  // The record as a server before this one kept it, its trigger since deleted.
  const body = { name: "form", source: { kind: "composio", server: "hs", event: FORM_EVENT.slug, config: { app_id: "4242", region: "eu", hub_value: value } } };
  const answer = { status: 201, body: { id, ...body }, headers: { location: `/v2/triggers/${id}` } };
  const { stable } = await import("../dist/validate.js");
  const file = join(s.server.data, ".idempotency.json");
  writeFileSync(file, JSON.stringify({ version: 1, entries: [[`/triggers\nform-key`, { fingerprint: stable(body), at: Date.now(), answer }]] }), { mode: 0o600 });
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl } });
  assert.ok(!readFileSync(file, "utf8").includes(value), "the start wrote the record masked before any request");
  const replay = await again.api("POST", "/triggers", body, { "idempotency-key": "form-key" });
  assert.equal(replay.headers.get("idempotent-replayed"), "true", "the record still replays");
  assert.equal(replay.body.source.config.hub_value, MASK, "its replay is masked");
  assert.ok(!JSON.stringify(replay.body).includes(value), "and holds no value");
});

test("deleting a trigger whose cached create answer holds a field in the clear masks that answer at once and saves it, so no later start has to find the trigger to mask it", async (t) => {
  const { s, value, id } = await keptUnmarked(t);
  await s.composio.close();
  const body = { name: "form", source: { kind: "composio", server: "hs", event: FORM_EVENT.slug, config: { app_id: "4242", region: "eu", hub_value: value } } };
  const answer = { status: 201, body: { id, ...body }, headers: { location: `/v2/triggers/${id}` } };
  const { stable } = await import("../dist/validate.js");
  const file = join(s.server.data, ".idempotency.json");
  writeFileSync(file, JSON.stringify({ version: 1, entries: [[`/triggers\nform-key`, { fingerprint: stable(body), at: Date.now(), answer }]] }), { mode: 0o600 });
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl } });
  assert.ok(readFileSync(file, "utf8").includes(value), "with no seal at this start (Composio down), the record is in the clear before the delete");
  const deleted = await again.api("DELETE", `/triggers/${id}`);
  assert.ok([200, 204].includes(deleted.status), `deleted here (200 says what Composio kept): ${deleted.status}`);
  assert.ok(!readFileSync(file, "utf8").includes(value), "the delete saved the record masked");
  const replay = await again.api("POST", "/triggers", body, { "idempotency-key": "form-key" });
  assert.equal(replay.headers.get("idempotent-replayed"), "true", "the record still replays");
  assert.equal(replay.body.source.config.hub_value, MASK, "its replay is masked");
});

test("with Composio down, the start still serves, says once by a code that the schemas were not read, and leaves the trigger for the next start", async (t) => {
  const { s, value, id } = await keptUnmarked(t);
  await s.composio.close();
  const lines = [];
  const again = await serve(t, { data: s.server.data, publicUrl: PUBLIC, composioControl: { baseUrl: s.composio.baseUrl }, log: (line) => lines.push(line) });
  assert.equal((await again.api("GET", "/triggers")).status, 200, "the start serves");
  const said = await lineOf(lines, (l) => l.includes("composio_config_schemas_unread"));
  assert.ok(said, `a schema read that failed is said: ${JSON.stringify(lines.filter((l) => l.includes("composio")))}`);
  assert.equal(lines.filter((l) => l.includes("composio_config_schemas_unread")).length, 1, "once");
  assert.match(said, /error=[a-z_]+/, "by a code");
  assert.equal((await again.api("GET", `/triggers/${id}`)).body.source.config.hub_value, value, "the trigger is left as it was, for the next start");
});

