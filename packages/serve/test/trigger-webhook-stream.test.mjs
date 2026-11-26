// A webhook trigger signed `stream`: Sandbar Stream's webhook, which its phone app posts for every saved interaction as
// `{"text", "interaction_id"}`, signed (Sign requests) as its support article "Set up Stream Webhook" gives it:
// `X-Stream-Signature: t=<Unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, keyed by the whole secret Stream
// made, its `swh_` prefix included. Stream makes that secret, so the trigger is made with none, refuses every request
// until the owner gives it, and never answers it. The signatures here are made with node:crypto from that formula, not
// with the server's code.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { Webhook } from "standardwebhooks";
import { serve } from "./support.mjs";
import { firings, keyOf, made } from "./trigger-support.mjs";

/** A secret as Stream shows one: `swh_` and 43 characters. */
const streamSecret = () => `swh_${randomBytes(32).toString("base64url")}`;
const note = (text, id = crypto.randomUUID().toUpperCase()) => JSON.stringify({ interaction_id: id, text });
/** Stream's signature of `body` at `t` (Unix seconds) under `secret`, as its docs give it. */
const streamSignature = (secret, body, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const streamTrigger = (agentId, source = {}) => ({ name: "ring", source: { kind: "webhook", signature: "stream", ...source }, target: { kind: "start_run", agent_id: agentId, input: { content: "A voice note from the ring." }, max_cost_usd: 0.5 } });

/** A POST to the trigger's hook as Stream's phone sends one: no token, the body as given, `headers` beside it. */
async function post(baseUrl, id, body, headers) {
  const res = await fetch(`${baseUrl}/hooks/${id}`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Sandbar/762 CFNetwork/3896.200.61 Darwin/27.2.0", ...headers }, body });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, body: json ?? text };
}

test("a stream trigger starts with no secret and refuses every request; once the owner gives Stream's, a note Stream signs fires once, keyed by its interaction_id, and the secret is never answered", { timeout: 120_000 }, async (t) => {
  const { api, baseUrl, token } = await serve(t);
  await made(api, "arun");
  const secret = streamSecret();

  const created = await api("POST", "/triggers", streamTrigger("arun"));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id } = created.body;
  assert.equal(created.body.signing_secret, undefined, "none is made for it");
  assert.equal(created.body.secret.set, false, JSON.stringify(created.body.secret));
  assert.match(created.body.note, /Stream makes this trigger's secret: give it with PUT \/v2\/triggers\/.+\/secret/);

  const first = note("Arun, remind me to check the article tomorrow.", "72358766-2B3E-420B-955F-9680F869EBEB");
  assert.equal((await post(baseUrl, id, first, { "x-stream-signature": streamSignature(secret, first) })).status, 401, "no secret yet: refused");

  // The secret is the owner's to give: the token is refused, and the body is checked before anything changes.
  const byToken = await fetch(`${baseUrl}/triggers/${id}/secret`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ secret }) });
  assert.equal(byToken.status, 403, await byToken.text());
  for (const [body, field, reason] of [[{}, "secret", "missing"], [{ secret: 42 }, "secret", "wrong_type"], [{ secret: `whsec_${randomBytes(32).toString("base64")}` }, "secret", "invalid"], [{ secret, also: 1 }, "also", undefined]]) {
    const refused = await api("PUT", `/triggers/${id}/secret`, body);
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    const issue = refused.body.error.fields.find((f) => f.field === field);
    assert.ok(issue && (reason === undefined || issue.reason === reason), JSON.stringify(refused.body));
  }
  // PUT takes a body: none at all is the server's one 400 for a body that is not a JSON object.
  assert.equal((await api("PUT", `/triggers/${id}/secret`)).status, 400);
  assert.equal((await api("GET", `/triggers/${id}`)).body.secret.set, false, "a refused body set nothing");

  // POST mints a secret, and none is minted for a stream trigger: it points to PUT, and changes nothing.
  const rotate = await api("POST", `/triggers/${id}/secret`);
  assert.equal(rotate.status, 422, JSON.stringify(rotate.body));
  assert.equal(rotate.body.error.fields[0].field, "source.signature");
  assert.match(rotate.body.error.fields[0].message, /give it with PUT \/v2\/triggers\/.+\/secret/);
  assert.equal((await api("GET", `/triggers/${id}`)).body.secret.set, false);

  const given = await api("PUT", `/triggers/${id}/secret`, { secret });
  assert.equal(given.status, 200, JSON.stringify(given.body));
  assert.equal(given.body.secret.set, true);
  assert.equal(given.body.signing_secret, undefined, "the owner's own secret is not answered back");
  assert.ok(!JSON.stringify(given.body).includes(secret));
  const read = await api("GET", `/triggers/${id}`);
  assert.equal(read.body.secret.set, true);
  assert.ok(!JSON.stringify(read.body).includes(secret), "no GET shows it");

  // Stream's request, as its phone sends it.
  const fired = await post(baseUrl, id, first, { "x-stream-signature": streamSignature(secret, first) });
  assert.equal(fired.status, 202, JSON.stringify(fired.body));
  assert.deepEqual([fired.body.key, fired.body.by], [keyOf("webhook", id, "stream:72358766-2B3E-420B-955F-9680F869EBEB"), "webhook"]);
  // The same note signed again, under another t: its interaction_id is signed, so it is the same firing.
  const again = await post(baseUrl, id, first, { "x-stream-signature": streamSignature(secret, first, Math.floor(Date.now() / 1000) - 30) });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.equal(again.body.key, fired.body.key);
  const [firing] = await firings(api, id, 1);
  assert.equal(firing.status, "started", JSON.stringify(firing));

  // Every way a request is not Stream's under this secret is the one 401.
  const other = note("Arun, a second note.");
  const now = Math.floor(Date.now() / 1000);
  const standardId = "msg_stream_test";
  for (const [why, body, headers] of [
    ["unsigned", other, {}],
    ["another secret", other, { "x-stream-signature": streamSignature(streamSecret(), other) }],
    ["a changed body", other, { "x-stream-signature": streamSignature(secret, note("Arun, something else.")) }],
    ["a stale t", other, { "x-stream-signature": streamSignature(secret, other, now - 301) }],
    ["a future t", other, { "x-stream-signature": streamSignature(secret, other, now + 301) }],
    ["a malformed header", other, { "x-stream-signature": `t=${now},v1=nothex` }],
    ["signed as Standard Webhooks", other, { "webhook-id": standardId, "webhook-timestamp": String(now), "webhook-signature": new Webhook(`whsec_${randomBytes(32).toString("base64")}`).sign(standardId, new Date(now * 1000), other) }],
  ]) assert.equal((await post(baseUrl, id, body, headers)).status, 401, why);

  // More than one v1 (Stream rotating): any one that matches passes, and fields it may add are skipped.
  const third = note("Arun, a third note.");
  const v1 = streamSignature(secret, third).split(",")[1];
  const rotating = await post(baseUrl, id, third, { "x-stream-signature": `t=${now},v1=${"0".repeat(64)},${v1},v2=later` });
  assert.equal(rotating.status, 202, JSON.stringify(rotating.body));
});

test("a stream trigger's accept reads what was said: only a note that starts with the wake name starts a run", { timeout: 120_000 }, async (t) => {
  const { api, baseUrl } = await serve(t);
  await made(api, "arun");
  const secret = streamSecret();
  const created = await api("POST", "/triggers", streamTrigger("arun", { accept: [{ event: "interaction", where: [{ pointer: "/text", prefix: "Arun" }] }] }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id } = created.body;
  assert.equal((await api("PUT", `/triggers/${id}/secret`, { secret })).status, 200);

  const groceries = note("Add oat milk to my grocery list.");
  const ignored = await post(baseUrl, id, groceries, { "x-stream-signature": streamSignature(secret, groceries) });
  assert.deepEqual([ignored.status, ignored.body], [200, { ok: "ignored" }]);
  const wake = note("Arun, draft the weekly update.");
  const fired = await post(baseUrl, id, wake, { "x-stream-signature": streamSignature(secret, wake) });
  assert.equal(fired.status, 202, JSON.stringify(fired.body));
  const [firing] = await firings(api, id, 1);
  assert.equal(firing.status, "started", JSON.stringify(firing));
});

test("a trigger whose secret is made here still takes no body on rotate and no secret of the sender's, and no PATCH moves a trigger between a secret made here and Stream's", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  await made(api, "arun");
  const standard = await api("POST", "/triggers", { ...streamTrigger("arun"), name: "deploys", source: { kind: "webhook" } });
  assert.equal(standard.status, 201, JSON.stringify(standard.body));
  const minted = standard.body.signing_secret;
  for (const body of [{ secret: streamSecret() }, {}]) {
    const refused = await api("POST", `/triggers/${standard.body.id}/secret`, body);
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.error.fields[0].field, "body");
  }
  const put = await api("PUT", `/triggers/${standard.body.id}/secret`, { secret: streamSecret() });
  assert.equal(put.status, 422, JSON.stringify(put.body));
  assert.deepEqual([put.body.error.fields[0].field, put.body.error.fields[0].reason], ["secret", "not_allowed"]);
  const rotated = await api("POST", `/triggers/${standard.body.id}/secret`);
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
  assert.match(rotated.body.signing_secret, /^whsec_/);
  assert.notEqual(rotated.body.signing_secret, minted);

  const stream = await api("POST", "/triggers", streamTrigger("arun"));
  assert.equal(stream.status, 201, JSON.stringify(stream.body));
  for (const [id, signature] of [[standard.body.id, "stream"], [stream.body.id, "standard"], [stream.body.id, "github"]]) {
    const moved = await api("PATCH", `/triggers/${id}`, { source: { kind: "webhook", signature } });
    assert.equal(moved.status, 422, JSON.stringify(moved.body));
    assert.equal(moved.body.error.fields[0].field, "source.signature");
  }
  // Within its own kind of secret a PATCH still moves it: standard to github keeps the secret made here.
  assert.equal((await api("PATCH", `/triggers/${standard.body.id}`, { source: { kind: "webhook", signature: "github" } })).status, 200);
});
