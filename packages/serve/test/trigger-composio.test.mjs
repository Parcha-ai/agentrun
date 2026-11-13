// Composio's triggers fire runs through the webhook trigger: `signature: "composio"` checks Composio's delivery (headers
// webhook-id, webhook-timestamp and webhook-signature `v1,<base64 HMAC-SHA256 of "{id}.{timestamp}.{body}">`, keyed by
// the UTF-8 bytes of the whole secret string Composio gave, as @composio/core signs and verifies), keys each firing by
// its webhook-id and reads its event from the body's metadata.trigger_slug. The secret is Composio's, given at the create
// and replaced by a body to POST /triggers/{id}/secret; it is sealed like a minted one and shown nowhere.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { webhook } from "../dist/trigger-webhook.js";
import { call, cookieOf, serve, storeBytes, withEnv } from "./support.mjs";
import { keyOf, made } from "./trigger-support.mjs";

const { Webhook } = createRequire(import.meta.url)("standardwebhooks");
const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
// A secret as Composio mints one: not whsec_, not base64 of a key; the whole string is the key.
const SECRET = "cmp_whsec-Zk3Qm9xT1vB7nLp0RuYd2eWc4HsJ8aGf";
const OTHER = "cmp_whsec-Pq5Xn2cV8mTb1rKd7YuL0eHw3AsJ6gZf";

/** A delivery signed as @composio/core does: HMAC-SHA256 over `${id}.${timestamp}.${body}`, keyed by the secret's UTF-8 bytes. */
const sign = (secret, id, at, body) => `v1,${createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${at}.${body}`).digest("base64")}`;
const delivery = (slug = "GITHUB_ISSUE_ADDED_EVENT", extra = {}) =>
  JSON.stringify({ id: "msg_1", type: "composio.trigger.message", metadata: { log_id: "log_1", trigger_slug: slug, trigger_id: "ti_abc123", connected_account_id: "ca_1", auth_config_id: "ac_1", user_id: "user_42" }, data: { repository: "o/r", labels: ["bug"] }, timestamp: "2026-11-13T00:00:00Z", ...extra });

async function post(baseUrl, triggerId, body, { secret = SECRET, id = `msg_${randomBytes(8).toString("hex")}`, at = Math.floor(Date.now() / 1000), headers } = {}) {
  const signed = headers ?? { "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": sign(secret, id, at, body) };
  const res = await fetch(`${baseUrl}/hooks/${triggerId}`, { method: "POST", headers: { "content-type": "application/json", ...signed }, body });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, body: json ?? text, id };
}

/** A composio trigger as it is made: with no secret, then given Composio's through the secret route (the owner's write). */
async function composioTrigger(api, source = { kind: "webhook", signature: "composio" }, secret = SECRET) {
  const made = await api("POST", "/triggers", hooked("triage", source));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const set = await api("POST", `/triggers/${made.body.id}/secret`, { secret });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  return made.body;
}

let count = 0;
const hooked = (agentId, source = { kind: "webhook", signature: "composio" }, extra = {}) => ({ name: `composio ${++count}`, source, target: { kind: "start_run", agent_id: agentId, input: { content: "Triage this." }, max_cost_usd: 0.5 }, ...extra });

test("the composio scheme verifies what Composio's SDK signs, keyed by the UTF-8 secret, and reads its event, firing key and tag from the body and headers", () => {
  const body = Buffer.from(delivery());
  const now = Date.now();
  const at = Math.floor(now / 1000);
  const headers = { "webhook-id": "msg_x", "webhook-timestamp": String(at), "webhook-signature": sign(SECRET, "msg_x", at, body.toString()) };
  const source = { kind: "webhook", signature: "composio", accept: [{ event: "GITHUB_ISSUE_ADDED_EVENT", where: [{ pointer: "/data/repository", in: ["o/r"] }] }] };
  assert.equal(webhook.push.headers(headers, now), undefined);
  assert.equal(webhook.push.verify(SECRET, headers, body, now, source), undefined);
  assert.equal(webhook.push.verify(OTHER, headers, body, now, source), "bad_signature");
  assert.equal(webhook.push.verify("short", { ...headers, "webhook-signature": sign("short", "msg_x", at, body.toString()) }, body, now, source), "short_key", "a key under the floor is refused");
  // A list of signatures (rotation): any one may match.
  assert.equal(webhook.push.verify(SECRET, { ...headers, "webhook-signature": `v1,AAAA ${headers["webhook-signature"]}` }, body, now, source), undefined);
  const [fired] = webhook.push.parse(headers, body, source);
  assert.equal(fired.key, "msg_x");
  assert.deepEqual(fired.attrs, { scheme: "composio", event: "GITHUB_ISSUE_ADDED_EVENT", trigger_id: "ti_abc123", user_id: "user_42" });
  const other = webhook.push.parse(headers, Buffer.from(delivery("SLACK_NEW_MESSAGE")), source);
  assert.equal(other.ignored !== undefined, true, "another slug is not taken");
});

test("a composio delivery fires once, keyed by its webhook-id; the same id again is the same firing; another slug is ignored; a stale timestamp is 401", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, baseUrl } = await serve(t);
  await made(api, "triage");
  const created = await composioTrigger(api, { kind: "webhook", signature: "composio", accept: [{ event: "GITHUB_ISSUE_ADDED_EVENT" }] });
  const { id } = created;
  assert.equal(created.signing_secret, undefined, "Composio's secret is not echoed");
  assert.equal((await api("GET", `/triggers/${id}`)).body.secret.set, true);
  // A change's answer says the secret is set too, as a read does: a page that shows the answer after Pause or Resume
  // never says a working secret is missing.
  for (const enabled of [false, true]) assert.equal((await api("PATCH", `/triggers/${id}`, { enabled })).body.secret?.set, true, `PATCH enabled:${enabled}`);
  const first = await post(baseUrl, id, delivery(), { id: "msg_one" });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(first.body.key, keyOf("webhook", id, "msg_one"));
  const again = await post(baseUrl, id, delivery(), { id: "msg_one" });
  assert.deepEqual([again.status, again.headers.get("idempotent-replayed"), again.body.key], [200, "true", first.body.key]);
  const ignored = await post(baseUrl, id, delivery("SLACK_NEW_MESSAGE"));
  assert.deepEqual([ignored.status, ignored.body], [200, { ok: "ignored" }]);
  // An account event has no slug: its event is the body's type, which a slug rule does not take.
  const expired = JSON.stringify({ id: "msg_2", type: "composio.connected_account.expired", data: { id: "ca_1" }, timestamp: "2026-11-13T00:00:00Z" });
  assert.deepEqual((await post(baseUrl, id, expired)).body, { ok: "ignored" });
  const accountOnly = await composioTrigger(api, { kind: "webhook", signature: "composio", accept: [{ event: "composio.connected_account.expired" }] });
  const took = await post(baseUrl, accountOnly.id, expired);
  assert.equal(took.status, 202, JSON.stringify(took.body));
  const stale = await post(baseUrl, id, delivery(), { at: Math.floor(Date.now() / 1000) - 400 });
  assert.equal(stale.status, 401);
});

test("a Standard Webhooks signature is 401 on a composio trigger, and a composio signature is 401 on a standard one", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, baseUrl } = await serve(t);
  await made(api, "triage");
  const composio = await composioTrigger(api);
  const standard = (await api("POST", "/triggers", hooked("triage", { kind: "webhook" }))).body;
  assert.match(standard.signing_secret, /^whsec_/);
  const body = delivery();
  const at = Math.floor(Date.now() / 1000);
  const viaStandard = (secret) => ({ "webhook-id": "msg_s", "webhook-timestamp": String(at), "webhook-signature": new Webhook(secret).sign("msg_s", new Date(at * 1000), body) });
  assert.equal((await post(baseUrl, composio.id, body, { headers: viaStandard(standard.signing_secret) })).status, 401);
  // Even the secret pasted into Standard Webhooks' check is not Composio's signature.
  assert.equal((await post(baseUrl, standard.id, body, { secret: standard.signing_secret })).status, 401, "composio's HMAC under the standard secret's string");
  assert.equal((await post(baseUrl, standard.id, body, { secret: SECRET })).status, 401);
  assert.equal((await post(baseUrl, standard.id, body, { headers: viaStandard(standard.signing_secret) })).status, 202, "the standard trigger still takes its own");
});

test("a composio trigger is made before its secret (Composio makes it once the trigger's URL is registered): until one is set every request is 401; no create takes one; PATCH never moves a trigger between given and minted secrets", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, baseUrl } = await serve(t);
  await made(api, "triage");
  const none = await api("POST", "/triggers", hooked("triage"));
  assert.equal(none.status, 201, JSON.stringify(none.body));
  assert.deepEqual([none.body.secret.set, none.body.signing_secret], [false, undefined]);
  assert.equal((await post(baseUrl, none.body.id, delivery())).status, 401, "no secret, no request passes");
  assert.equal((await api("POST", `/triggers/${none.body.id}/secret`, { secret: SECRET })).status, 200);
  assert.equal((await post(baseUrl, none.body.id, delivery())).status, 202);
  // A create takes no secret, for any scheme: Composio makes it once the URL is registered.
  for (const source of [{ kind: "webhook" }, { kind: "webhook", signature: "github" }, { kind: "webhook", signature: "composio" }]) {
    const refused = await api("POST", "/triggers", hooked("triage", source, { secret: SECRET }));
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
  }
  for (const secret of ["short", "has a space in it, but long enough", 7]) assert.equal((await api("POST", `/triggers/${none.body.id}/secret`, { secret })).status, 422, String(secret));
  const composio = await composioTrigger(api);
  const standard = (await api("POST", "/triggers", hooked("triage", { kind: "webhook" }))).body;
  assert.equal((await api("PATCH", `/triggers/${composio.id}`, { source: { kind: "webhook" } })).status, 422);
  assert.equal((await api("PATCH", `/triggers/${standard.id}`, { source: { kind: "webhook", signature: "composio" } })).status, 422);
  assert.equal((await api("PATCH", `/triggers/${composio.id}`, { source: { kind: "webhook", signature: "composio", accept: [{ event: "X" }] } })).status, 200);
});

test("a composio trigger's secret is replaced by a body to POST /triggers/{id}/secret, and the old one stops; it is never minted for", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, baseUrl } = await serve(t);
  await made(api, "triage");
  const composio = await composioTrigger(api);
  const standard = (await api("POST", "/triggers", hooked("triage", { kind: "webhook" }))).body;
  assert.equal((await api("POST", `/triggers/${composio.id}/secret`)).status, 422, "no secret in the body: none is minted");
  assert.equal((await api("POST", `/triggers/${composio.id}/secret`, {})).status, 422);
  assert.equal((await api("POST", `/triggers/${standard.id}/secret`, { secret: OTHER })).status, 422, "a minted trigger takes none given");
  const rotated = await api("POST", `/triggers/${composio.id}/secret`, { secret: OTHER });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  assert.equal(rotated.body.signing_secret, undefined);
  assert.deepEqual([rotated.body.secret.name, rotated.body.secret.set], [`trigger:${composio.id}`, true]);
  assert.equal((await post(baseUrl, composio.id, delivery(), { secret: SECRET })).status, 401, "the old secret stops");
  assert.equal((await post(baseUrl, composio.id, delivery(), { secret: OTHER })).status, 202);
  assert.equal((await api("POST", `/triggers/${standard.id}/secret`)).status, 200, "a standard trigger is still minted for");
});

test("a composio secret that starts with whsec_ is kept by its whole string: a short decoded suffix is no reason to refuse it, and a delivery signed by its UTF-8 bytes fires", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, baseUrl } = await serve(t);
  await made(api, "triage");
  // 30 UTF-8 bytes, but its suffix decodes as base64 to 18.
  const odd = "whsec_abcdefghijklmnopqrstuvwx";
  const composio = await composioTrigger(api, undefined, odd);
  assert.equal((await post(baseUrl, composio.id, delivery(), { secret: odd })).status, 202);
});

test("Composio's secret is in no view and not in the store's bytes, only the owner's session may set it (the API token is 403 and the secret stays), and the API document marks it", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const server = await serve(t, { accounts: true, openSetup: true });
  const { api, data, baseUrl, port } = server;
  const origin = `http://127.0.0.1:${port}`;
  const setup = await call(port, { method: "POST", path: "/v2/setup", headers: { "content-type": "application/json", origin }, body: { password: "not-a-secret" } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  const page = async (method, path, body) => {
    const res = await call(port, { method, path: `/v2${path}`, headers: { cookie, origin, "content-type": "application/json" }, body });
    return { status: res.status, body: res.json ?? res.text };
  };
  const token = (method, path, body) => api(method, path, body, { authorization: `Bearer ${server.token}` });
  await made(api, "triage");
  const created = await page("POST", "/triggers", hooked("triage"));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  assert.equal((await page("POST", `/triggers/${id}/secret`, { secret: SECRET })).status, 200);
  for (const read of [await api("GET", `/triggers/${id}`), await api("GET", "/triggers"), await api("GET", `/triggers/${id}/firings`)]) assert.ok(!JSON.stringify(read.body).includes(SECRET));
  assert.ok(!storeBytes(data).includes(SECRET), "the store holds it only sealed");
  const refused = await token("POST", `/triggers/${id}/secret`, { secret: OTHER });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.ok(!JSON.stringify(refused.body).includes(OTHER));
  assert.equal((await post(baseUrl, id, delivery(), { secret: SECRET })).status, 202, "the secret the token tried to replace still signs");
  assert.equal((await post(baseUrl, id, delivery(), { secret: OTHER })).status, 401);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const create = doc.paths["/triggers"].post.requestBody.content["application/json"].schema.properties;
  assert.equal(create.secret, undefined, "the create takes no secret: it would make the CLI's create a secret write");
  assert.ok(doc.paths["/triggers/{trigger_id}/secret"].post.requestBody.content["application/json"].schema.properties.secret["x-agentrun-secret"]);
  assert.ok(JSON.stringify(doc).includes("composio"), "the scheme is documented");
  const changed = doc.paths["/triggers/{trigger_id}"].patch.responses["200"].content["application/json"].schema;
  assert.ok(changed.properties.secret, "a change's answer declares the secret metadata it carries");
});
