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
import { serve, withEnv } from "./support.mjs";
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
  const created = await api("POST", "/triggers", hooked("triage", { kind: "webhook", signature: "composio", accept: [{ event: "GITHUB_ISSUE_ADDED_EVENT" }] }, { secret: SECRET }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id } = created.body;
  assert.equal(created.body.signing_secret, undefined, "Composio's secret is not echoed");
  assert.deepEqual([created.body.secret.name, created.body.secret.set], [`trigger:${id}`, true]);
  const first = await post(baseUrl, id, delivery(), { id: "msg_one" });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.equal(first.body.key, keyOf("webhook", id, "msg_one"));
  const again = await post(baseUrl, id, delivery(), { id: "msg_one" });
  assert.deepEqual([again.status, again.headers.get("idempotent-replayed"), again.body.key], [200, "true", first.body.key]);
  const ignored = await post(baseUrl, id, delivery("SLACK_NEW_MESSAGE"));
  assert.deepEqual([ignored.status, ignored.body], [200, { ok: "ignored" }]);
  const stale = await post(baseUrl, id, delivery(), { at: Math.floor(Date.now() / 1000) - 400 });
  assert.equal(stale.status, 401);
});

test("a Standard Webhooks signature is 401 on a composio trigger, and a composio signature is 401 on a standard one", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, baseUrl } = await serve(t);
  await made(api, "triage");
  const composio = (await api("POST", "/triggers", hooked("triage", undefined, { secret: SECRET }))).body;
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

test("a composio trigger may be made before its secret (Composio makes it once the trigger's URL is registered): until one is set every request is 401; the other schemes refuse one; PATCH never moves a trigger between given and minted secrets", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, baseUrl } = await serve(t);
  await made(api, "triage");
  const none = await api("POST", "/triggers", hooked("triage"));
  assert.equal(none.status, 201, JSON.stringify(none.body));
  assert.deepEqual([none.body.secret.set, none.body.signing_secret], [false, undefined]);
  assert.equal((await post(baseUrl, none.body.id, delivery())).status, 401, "no secret, no request passes");
  assert.equal((await api("POST", `/triggers/${none.body.id}/secret`, { secret: SECRET })).status, 200);
  assert.equal((await post(baseUrl, none.body.id, delivery())).status, 202);
  for (const source of [{ kind: "webhook" }, { kind: "webhook", signature: "github" }]) {
    const refused = await api("POST", "/triggers", hooked("triage", source, { secret: SECRET }));
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
  }
  assert.equal((await api("POST", "/triggers", hooked("triage", undefined, { secret: "short" }))).status, 422);
  assert.equal((await api("POST", "/triggers", hooked("triage", undefined, { secret: "has a space in it, but long enough" }))).status, 422);
  assert.equal((await api("POST", "/triggers", hooked("triage", undefined, { secret: 7 }))).status, 422);
  const composio = (await api("POST", "/triggers", hooked("triage", undefined, { secret: SECRET }))).body;
  const standard = (await api("POST", "/triggers", hooked("triage", { kind: "webhook" }))).body;
  assert.equal((await api("PATCH", `/triggers/${composio.id}`, { source: { kind: "webhook" } })).status, 422);
  assert.equal((await api("PATCH", `/triggers/${standard.id}`, { source: { kind: "webhook", signature: "composio" } })).status, 422);
  assert.equal((await api("PATCH", `/triggers/${composio.id}`, { source: { kind: "webhook", signature: "composio", accept: [{ event: "X" }] } })).status, 200);
});

test("a composio trigger's secret is replaced by a body to POST /triggers/{id}/secret, and the old one stops; it is never minted for", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, baseUrl } = await serve(t);
  await made(api, "triage");
  const composio = (await api("POST", "/triggers", hooked("triage", undefined, { secret: SECRET }))).body;
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

test("Composio's secret is in no view, is sealed and cut like every trigger secret, and is a secret write", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, data, baseUrl } = await serve(t);
  await made(api, "triage");
  const composio = (await api("POST", "/triggers", hooked("triage", undefined, { secret: SECRET }))).body;
  for (const read of [await api("GET", `/triggers/${composio.id}`), await api("GET", "/triggers"), await api("GET", `/triggers/${composio.id}/firings`)]) assert.ok(!JSON.stringify(read.body).includes(SECRET));
  const { secretForms } = await import("../dist/standard-webhooks.js");
  assert.ok(secretForms(SECRET).includes(SECRET));
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const create = doc.paths["/triggers"].post.requestBody.content["application/json"].schema.properties;
  assert.equal(create.secret["x-agentrun-secret"], true, "named and marked in the API document");
  assert.ok(doc.paths["/triggers/{trigger_id}/secret"].post.requestBody.content["application/json"].schema.properties.secret["x-agentrun-secret"]);
  assert.ok(doc.paths["/triggers"].post.requestBody.content["application/json"].schema.properties.source, "the source stays");
  assert.ok(JSON.stringify(doc).includes("composio"), "the scheme is documented");
});
