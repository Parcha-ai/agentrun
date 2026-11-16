// Composio's events reach a run one way: a Composio trigger (kind "composio", made in Triggers → New app trigger), whose
// project's subscription this server makes and keeps (composio-triggers.ts). Its deliveries come to /v2/hooks/composio/{hook}
// and are checked with the composio scheme: the Standard Webhooks headers and message, `v1,<base64 HMAC-SHA256 of
// "{id}.{timestamp}.{body}">`, keyed by the UTF-8 bytes of the whole secret string Composio minted, as @composio/core signs
// and verifies. The old manual way, a webhook trigger with `signature: "composio"` and Composio's secret pasted in through
// the secret route, is gone: a create or change to it is refused, pointing to New app trigger, and the secret route
// takes no secret of the sender's.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { composio } from "../dist/trigger-composio.js";
import { call, clientOwnerSession, serve, withEnv } from "./support.mjs";
import { made } from "./trigger-support.mjs";

const { Webhook } = createRequire(import.meta.url)("standardwebhooks");

const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
// A secret as Composio mints one: not whsec_, not base64 of a key; the whole string is the key.
const SECRET = "cmp_whsec-Zk3Qm9xT1vB7nLp0RuYd2eWc4HsJ8aGf";
const OTHER = "cmp_whsec-Pq5Xn2cV8mTb1rKd7YuL0eHw3AsJ6gZf";
/** Where a refusal of the old way sends the owner. */
const POINTER = /Triggers → New app trigger/;

/** A delivery signed as @composio/core does: HMAC-SHA256 over `${id}.${timestamp}.${body}`, keyed by the secret's UTF-8 bytes. */
const sign = (secret, id, at, body) => `v1,${createHmac("sha256", Buffer.from(secret, "utf8")).update(`${id}.${at}.${body}`).digest("base64")}`;
const delivery = (slug = "GITHUB_ISSUE_ADDED_EVENT") =>
  JSON.stringify({ id: "msg_1", type: "composio.trigger.message", metadata: { log_id: "log_1", trigger_slug: slug, trigger_id: "ti_abc123", connected_account_id: "ca_1", auth_config_id: "ac_1", user_id: "user_42" }, data: { repository: "o/r", labels: ["bug"] } });

let count = 0;
const hooked = (agentId, source) => ({ name: `hook ${++count}`, source, target: { kind: "start_run", agent_id: agentId, input: { content: "Triage this." }, max_cost_usd: 0.5 } });
/** The one issue of a 422, which names the source's signature. */
const signatureIssue = (answer) => {
  assert.equal(answer.status, 422, JSON.stringify(answer.body));
  assert.deepEqual(answer.body.error.fields.map((f) => f.field), ["source.signature"], JSON.stringify(answer.body.error));
  return answer.body.error.fields[0].message;
};

test("the composio scheme verifies what Composio's SDK signs, keyed by the UTF-8 secret, and reads its event, firing key and tag from the body and headers", () => {
  const body = Buffer.from(delivery());
  const now = Date.now();
  const at = Math.floor(now / 1000);
  const headers = { "webhook-id": "msg_x", "webhook-timestamp": String(at), "webhook-signature": sign(SECRET, "msg_x", at, body.toString()) };
  assert.equal(composio.push.headers(headers, now), undefined);
  assert.equal(composio.push.verify(SECRET, headers, body, now), undefined);
  assert.equal(composio.push.verify(OTHER, headers, body, now), "bad_signature");
  assert.equal(composio.push.verify("short", { ...headers, "webhook-signature": sign("short", "msg_x", at, body.toString()) }, body, now), "short_key", "a key under the floor is refused");
  // A list of signatures (rotation): any one may match.
  assert.equal(composio.push.verify(SECRET, { ...headers, "webhook-signature": `v1,AAAA ${headers["webhook-signature"]}` }, body, now), undefined);
  // A secret that starts with whsec_ is still keyed by its whole string, not a decoded suffix.
  const odd = "whsec_abcdefghijklmnopqrstuvwx";
  assert.equal(composio.push.verify(odd, { ...headers, "webhook-signature": sign(odd, "msg_x", at, body.toString()) }, body, now), undefined);
  const [fired] = composio.push.parse(headers, body);
  assert.equal(fired.key, "msg_x");
  assert.equal(fired.event, "GITHUB_ISSUE_ADDED_EVENT");
  assert.deepEqual(fired.attrs, { scheme: "composio", event: "GITHUB_ISSUE_ADDED_EVENT", trigger_id: "ti_abc123", user_id: "user_42" });
  // An account event has no slug: its event is the body's type.
  const [expired] = composio.push.parse(headers, Buffer.from(JSON.stringify({ id: "msg_2", type: "composio.connected_account.expired", data: { id: "ca_1" } })));
  assert.equal(expired.event, "composio.connected_account.expired");
});

test("a webhook trigger takes no composio signature: its create and a change to it are refused in words that point to Triggers → New app trigger, and nothing is kept", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api } = await serve(t);
  await made(api, "triage");
  const refused = await api("POST", "/triggers", hooked("triage", { kind: "webhook", signature: "composio" }));
  assert.match(signatureIssue(refused), POINTER);
  assert.match(refused.body.error.message, POINTER, "the refusal's own words point there too");
  const filtered = await api("POST", "/triggers", hooked("triage", { kind: "webhook", signature: "composio", accept: [{ event: "GITHUB_ISSUE_ADDED_EVENT" }] }));
  assert.match(signatureIssue(filtered), POINTER);
  assert.deepEqual((await api("GET", "/triggers")).body.triggers, [], "nothing kept");
  const standard = await api("POST", "/triggers", hooked("triage", { kind: "webhook" }));
  assert.equal(standard.status, 201, JSON.stringify(standard.body));
  const changed = await api("PATCH", `/triggers/${standard.body.id}`, { source: { kind: "webhook", signature: "composio" } });
  assert.match(signatureIssue(changed), POINTER);
  assert.equal((await api("GET", `/triggers/${standard.body.id}`)).body.source.signature, undefined, "the trigger is as it was");
  // The schemes a webhook takes still move between each other.
  const github = await api("PATCH", `/triggers/${standard.body.id}`, { source: { kind: "webhook", signature: "github" } });
  assert.equal(github.status, 200, JSON.stringify(github.body));
  // Any other name is refused naming the two it may be.
  assert.match(signatureIssue(await api("POST", "/triggers", hooked("triage", { kind: "webhook", signature: "slack" }))), /standard, github/);
});

test("the secret route takes no secret of the sender's: every webhook trigger's is made here, a body's secret is refused, and the API document's route has no body", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const { api, baseUrl } = await serve(t);
  await made(api, "triage");
  for (const source of [{ kind: "webhook" }, { kind: "webhook", signature: "github" }]) {
    const trigger = (await api("POST", "/triggers", hooked("triage", source))).body;
    const given = await api("POST", `/triggers/${trigger.id}/secret`, { secret: OTHER });
    assert.equal(given.status, 422, JSON.stringify(given.body));
    assert.ok(!JSON.stringify(given.body).includes(OTHER));
    const minted = await api("POST", `/triggers/${trigger.id}/secret`);
    assert.equal(minted.status, 200, JSON.stringify(minted.body));
    assert.ok(minted.body.signing_secret, "one is made and shown this once");
  }
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const route = doc.paths["/triggers/{trigger_id}/secret"].post;
  assert.equal(route.requestBody, undefined, "the route takes no body");
  assert.doesNotMatch(JSON.stringify(route), /Composio/, "nor says a Composio secret is given there");
  assert.doesNotMatch(JSON.stringify(doc), /secret Composio gave/);
});

test("the secret route refuses any body, an empty JSON object too, in words, before it rotates: the old secret still signs", { timeout: 60_000 }, async (t) => {
  withEnv(t, SEAL);
  const server = await serve(t);
  const { api, baseUrl } = server;
  await made(api, "triage");
  const trigger = (await api("POST", "/triggers", hooked("triage", { kind: "webhook" }))).body;
  const first = await api("POST", `/triggers/${trigger.id}/secret`);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const secret = first.body.signing_secret;
  const changedAt = (await api("GET", `/triggers/${trigger.id}`)).body.secret.changed_at;
  /** A body signed by `withSecret`, POSTed to the trigger's hook with no token: its status. */
  const delivered = async (withSecret) => {
    const msg = `msg_${randomBytes(8).toString("hex")}`;
    const body = JSON.stringify({ type: "push" });
    const at = new Date();
    const res = await fetch(`${baseUrl}/hooks/${trigger.id}`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": msg, "webhook-timestamp": String(Math.floor(at.getTime() / 1000)), "webhook-signature": new Webhook(withSecret).sign(msg, at, body) }, body });
    await res.text();
    return res.status;
  };
  const { cookie, origin } = await clientOwnerSession(server);
  const sent = (headers) => call(server.port, { method: "POST", path: `/v2/triggers/${trigger.id}/secret`, headers: { cookie, origin, "content-type": "application/json", ...headers }, body: "{}" });
  // `{}` with its length, as a client that always sends a JSON body does, and `{}` chunked: each a body, each refused.
  for (const [how, headers] of [["content-length 2", { "content-length": "2" }], ["chunked", { "transfer-encoding": "chunked" }]]) {
    const answer = await sent(headers);
    assert.equal(answer.status, 422, `${how}: ${answer.text}`);
    assert.equal(answer.json.error.code, "input_invalid", answer.text);
    assert.match(answer.json.error.message, /takes no body/, answer.text);
    assert.ok(!answer.text.includes("whsec_"), `${how}: no secret made or shown`);
    assert.equal((await api("GET", `/triggers/${trigger.id}`)).body.secret.changed_at, changedAt, `${how}: the secret is as it was`);
    assert.equal(await delivered(secret), 202, `${how}: the secret it would replace still signs`);
  }
  // With no body at all it rotates, and the old secret signs nothing from then on.
  const next = await api("POST", `/triggers/${trigger.id}/secret`);
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.notEqual(await delivered(secret), 202, "the old secret no longer signs");
  assert.equal(await delivered(next.body.signing_secret), 202);
});

test("a webhook trigger's signatures are standard and GitHub's: the capabilities, the API document's schema and the refusal name those two", { timeout: 60_000 }, async (t) => {
  const { api, baseUrl } = await serve(t);
  assert.deepEqual((await api("GET", "/capabilities")).body.features.triggers.webhook.signatures, ["standard", "github"]);
  const doc = await (await fetch(`${baseUrl}/openapi.json`)).json();
  // Every webhook source schema in the document: each one's `signature` names the two.
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (node.properties?.kind?.const === "webhook" && node.properties.signature) found.push(node.properties.signature.enum);
    Object.values(node).forEach(walk);
  };
  walk(doc);
  assert.ok(found.length > 0, "the webhook source's schema is in the document");
  for (const names of found) assert.deepEqual(names, ["standard", "github"]);
  assert.deepEqual(doc.components.schemas.Features.properties.triggers.properties.webhook.properties.signatures.items.enum, ["standard", "github"]);
});
