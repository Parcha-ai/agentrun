// A Composio trigger's config can hold a credential: HubSpot's deal-stage event takes {app_id, developer_api_key}. A field
// named like a key, token, secret, password or credential (trigger-composio.ts sealedConfigFields: Composio's trigger
// schemas mark no field secret) is sealed at the save, in the composio source's sealed settings beside the
// subscription's secret, and the trigger keeps "[sealed]" in its place with the field named in `sealed_config`. Composio
// gets the real value at the upsert. No answer, stored row, Idempotency-Key record or log line holds it. A PATCH that
// leaves it out or sends "[sealed]" keeps it; one that sends another value is refused, as any change to a composio
// trigger's config is. A trigger saved with its key in the clear before this rule is sealed at the next start.
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
  const sealed = ["developer_api_key", "api_key", "apiKey", "APIKey", "apikey", "key", "private_key", "access_key", "client_secret", "secret", "webhook_secret", "access_token", "token", "refreshToken", "bot_token", "password", "passwd", "passphrase", "credential", "credentials", "auth_token", "signing_key", "token_count"];
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
      config: { app_id: "\${parameters.app_id}", developer_api_key: "\${parameters.developer_api_key}" }
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
