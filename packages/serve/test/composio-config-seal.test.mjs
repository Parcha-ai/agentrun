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
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { scratch, secretWritePath, serve } from "./support.mjs";
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
  const sealed = ["developer_api_key", "api_key", "apiKey", "APIKey", "apikey", "key", "private_key", "access_key", "client_secret", "secret", "webhook_secret", "access_token", "token", "refreshToken", "bot_token", "password", "passwd", "passphrase", "credential", "credentials", "auth_token", "signing_key", "token_count", "authorization", "Authorization", "bearer", "bearer_value", "cookie", "session_cookie", "setCookie"];
  const kept = ["app_id", "owner", "repo", "key_id", "keyword", "keywords", "channel_id", "max_tokens", "monkey", "turkey", "secretary", "tokenizer", "author"];
  const config = Object.fromEntries([...sealed, ...kept].map((name) => [name, `value-of-${name}`]));
  assert.deepEqual(composio.sealedConfigFields(config).sort(), [...sealed].sort());
  assert.deepEqual(composio.sealedConfigFields({ api_key: 42, token: true, secret: { nested: "x" }, password: "" }), [], "a non-string or empty value is no credential to seal");
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
  const key = fakeKey();
  const made = await s.api("POST", "/triggers", dealTrigger(key), { "idempotency-key": "deal-still" });
  const again = await s.api("POST", "/triggers", dealTrigger(key), { "idempotency-key": "deal-still" });
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(again.body.source.config.developer_api_key, MASK, "the trigger create's replay is masked");
  assert.equal(again.body.id, made.body.id);
});
