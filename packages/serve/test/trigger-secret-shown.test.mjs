// A signing secret this server mints (a webhook trigger's, the outbound webhook's) is shown once, as `signing_secret`, and
// only to the owner's signed-in session, as the console's Triggers and Settings → Webhook screens are: the API token, which
// a run's process or a script may hold, gets what it made with the secret's metadata (`secret`, the one shape) and the
// words that send the person to the console. A rotation is a secret write: the token is refused it in the secret-write
// words, and the secret it would replace still signs.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { call, cookieOf, serve, withEnv } from "./support.mjs";
import { made } from "./trigger-support.mjs";

const { Webhook } = createRequire(import.meta.url)("standardwebhooks");
const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
/** A test password, no real one. */
const PASSWORD = "not-a-secret-owner";

const TRIGGER_WORDS = "Open the console to see this trigger's signing secret once: rotate it there.";
const WEBHOOK_WORDS = "Open the console to see this webhook's signing secret once: remove it and save it again there.";
const REFUSAL = "Saving, replacing or removing a secret takes the owner's signed-in session in the console; the API token can't write secrets.";

const hooked = (agentId) => ({ name: "on push", source: { kind: "webhook" }, target: { kind: "start_run", agent_id: agentId, input: { content: "Triage this event." }, max_cost_usd: 0.5 } });

/** A server with accounts on, its owner's password set: the token's client (`api`) and the owner's session (`page`). */
async function owned(t) {
  withEnv(t, SEAL);
  const server = await serve(t, { accounts: true, openSetup: true });
  const origin = `http://127.0.0.1:${server.port}`;
  const set = await call(server.port, { method: "POST", path: "/v2/setup", headers: { "content-type": "application/json", origin }, body: { password: PASSWORD } });
  assert.equal(set.status, 201, set.text);
  const cookie = cookieOf(set);
  /** A request from the owner's signed-in page: its cookie, its own origin and the JSON type (with no body too), as the
   *  console sends. */
  const page = async (method, path, body) => {
    const res = await call(server.port, { method, path: `/v2${path}`, headers: { cookie, origin, ...(method === "GET" ? {} : { "content-type": "application/json" }) }, body });
    return { status: res.status, body: res.json ?? res.text, text: res.text };
  };
  /** A request with the API token itself, as a script sends it (the client sends a secret write from a session). */
  const token = (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${server.token}` });
  return { ...server, page, token };
}

/** A body signed by `secret`, POSTed to trigger `id`'s hook with no token: its status. */
async function signed(baseUrl, id, secret) {
  const msg = `msg_${randomBytes(8).toString("hex")}`;
  const body = JSON.stringify({ type: "push" });
  const at = new Date();
  const res = await fetch(`${baseUrl}/hooks/${id}`, { method: "POST", headers: { "content-type": "application/json", "webhook-id": msg, "webhook-timestamp": String(Math.floor(at.getTime() / 1000)), "webhook-signature": new Webhook(secret).sign(msg, at, body) }, body });
  await res.text();
  return res.status;
}

test("a webhook trigger made with the API token: the trigger with secret_set true and the console's words, never its secret", async (t) => {
  const { api, token } = await owned(t);
  await made(api, "triage");
  const created = await token("POST", "/triggers", hooked("triage"));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.id, /^trg_/);
  assert.equal(created.body.secret_set, true);
  assert.deepEqual([created.body.secret.name, created.body.secret.set, created.body.secret.source], [`trigger:${created.body.id}`, true, "console"]);
  assert.equal(created.body.note, TRIGGER_WORDS);
  assert.ok(!("signing_secret" in created.body), JSON.stringify(created.body));
  assert.ok(!JSON.stringify(created.body).includes("whsec_"), "no secret anywhere in the token's answer");
});

test("a webhook trigger made from the owner's signed-in session: its secret, shown this once, and a body it signs fires", async (t) => {
  const { api, page, baseUrl } = await owned(t);
  await made(api, "triage");
  const created = await page("POST", "/triggers", hooked("triage"));
  assert.equal(created.status, 201, created.text);
  assert.match(created.body.signing_secret, /^whsec_/);
  assert.deepEqual(Object.keys(created.body.secret).sort(), ["changed_at", "name", "set", "source"]);
  assert.deepEqual([created.body.secret.name, created.body.secret.set, created.body.secret.source], [`trigger:${created.body.id}`, true, "console"]);
  assert.equal(await signed(baseUrl, created.body.id, created.body.signing_secret), 202);
  const read = await api("GET", `/triggers/${created.body.id}`);
  assert.ok(!JSON.stringify(read.body).includes("whsec_"), "GET never shows it again");
  assert.deepEqual(read.body.secret, { name: `trigger:${created.body.id}`, set: true, source: "console", changed_at: null }, "GET says it is set, in the one shape");
  const listed = (await api("GET", "/triggers")).body.triggers.find((one) => one.id === created.body.id);
  assert.deepEqual(listed.secret, read.body.secret);
});

test("rotating a trigger's secret with the API token is refused in the secret-write words, and the secret stays; the owner's session rotates it", async (t) => {
  const { api, page, token, baseUrl } = await owned(t);
  await made(api, "triage");
  const created = await page("POST", "/triggers", hooked("triage"));
  assert.equal(created.status, 201, created.text);
  const refused = await token("POST", `/triggers/${created.body.id}/secret`);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.ok(JSON.stringify(refused.body).includes(REFUSAL), JSON.stringify(refused.body));
  assert.ok(!JSON.stringify(refused.body).includes("whsec_"));
  assert.equal(await signed(baseUrl, created.body.id, created.body.signing_secret), 202, "the secret the token tried to replace still signs");
  const rotated = await page("POST", `/triggers/${created.body.id}/secret`);
  assert.equal(rotated.status, 200, rotated.text);
  assert.match(rotated.body.signing_secret, /^whsec_/);
  assert.notEqual(rotated.body.signing_secret, created.body.signing_secret);
  assert.deepEqual([rotated.body.secret.name, rotated.body.secret.set], [`trigger:${created.body.id}`, true]);
  assert.equal(await signed(baseUrl, created.body.id, rotated.body.signing_secret), 202);
});

test("the outbound webhook set with the API token: its secret's metadata and the console's words, never the value; GET reads the same shape", async (t) => {
  const { api, token } = await owned(t);
  const saved = await token("PUT", "/settings/webhook", { url: "https://hooks.example.com/agentrun" });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.ok(!JSON.stringify(saved.body).includes("whsec_"), "no secret anywhere in the token's answer");
  assert.ok(!("signing_secret" in saved.body), JSON.stringify(saved.body));
  assert.equal(saved.body.note, WEBHOOK_WORDS);
  const meta = saved.body.secret;
  assert.deepEqual(Object.keys(meta).sort(), ["changed_at", "name", "set", "source"]);
  assert.deepEqual([meta.name, meta.set, meta.source], ["webhook:outbound", true, "console"]);
  assert.ok(!Number.isNaN(Date.parse(meta.changed_at)), meta.changed_at);
  const read = await api("GET", "/settings/webhook");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.secret, meta);
  assert.ok(!JSON.stringify(read.body).includes("whsec_"));
});

test("the outbound webhook set from the owner's session: its secret shown this once with its metadata; a later save keeps it and its time", async (t) => {
  const { page, token } = await owned(t);
  const saved = await page("PUT", "/settings/webhook", { url: "https://hooks.example.com/agentrun" });
  assert.equal(saved.status, 201, saved.text);
  assert.match(saved.body.signing_secret, /^whsec_/);
  assert.deepEqual([saved.body.secret.name, saved.body.secret.set, saved.body.secret.source], ["webhook:outbound", true, "console"]);
  const again = await page("PUT", "/settings/webhook", { url: "https://hooks.example.com/agentrun-2" });
  assert.equal(again.status, 200, again.text);
  assert.ok(!("signing_secret" in again.body), "a later save mints none, so shows none");
  assert.equal(again.body.secret.changed_at, saved.body.secret.changed_at, "the secret's own time, not the webhook's");
  const byToken = await token("PUT", "/settings/webhook", { url: "https://hooks.example.com/agentrun-3" });
  assert.equal(byToken.status, 200, "a later save is no secret write: the token may change the URL");
  assert.ok(!JSON.stringify(byToken.body).includes("whsec_"));
  assert.equal(byToken.body.secret.changed_at, saved.body.secret.changed_at);
});

test("no outbound webhook set: GET says so, with its secret not set", async (t) => {
  const { api } = await owned(t);
  const read = await api("GET", "/settings/webhook");
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { configured: false, secret: { name: "webhook:outbound", set: false, source: null, changed_at: null } });
});

test("a template that makes a webhook trigger says so in its apply answer: the console's words under the trigger, never its secret", { timeout: 120_000 }, async (t) => {
  withEnv(t, {}, ["PARALLEL_API_KEY", "MONID_API_KEY", "BROWSERBASE_API_KEY", "KERNEL_API_KEY", "TYPESAFE_API_KEY"]);
  const { api } = await owned(t);
  const applied = await api("POST", "/templates/inbound-lead/apply", { parameters: { icp: "B2B fintech, 50-2000 people, US or EU; never gambling operators", post_to: "none" } });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  const hooks = [];
  for (const [i, id] of applied.body.trigger_ids.entries()) if ((await api("GET", `/triggers/${id}`)).body.source.kind === "webhook") hooks.push(i);
  assert.ok(hooks.length > 0, "inbound-lead makes a webhook trigger");
  const said = applied.body.warnings.filter((w) => /^triggers\.\d+\.secret$/.test(w.field));
  assert.deepEqual(said.map((w) => [w.field, w.reason]), hooks.map((i) => [`triggers.${i}.secret`, "not_allowed"]));
  for (const w of said) assert.ok(w.message.endsWith(TRIGGER_WORDS), w.message);
  assert.ok(!JSON.stringify(applied.body).includes("whsec_"));
});

test("removing the outbound webhook takes its secret with it: the API token is refused in the secret-write words and the webhook stays; the owner's session removes it", async (t) => {
  const { page, token, api } = await owned(t);
  assert.equal((await page("PUT", "/settings/webhook", { url: "https://hooks.example.com/agentrun" })).status, 201);
  const refused = await token("DELETE", "/settings/webhook");
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.ok(JSON.stringify(refused.body).includes(REFUSAL), JSON.stringify(refused.body));
  assert.equal((await api("GET", "/settings/webhook")).body.configured, true, "the webhook stays");
  assert.equal((await page("DELETE", "/settings/webhook")).status, 204);
  assert.equal((await api("GET", "/settings/webhook")).body.configured, false);
});
