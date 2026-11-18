// The outbound webhook's Rotate secret (POST /v2/settings/webhook/secret): a new signing secret for the URL set now, made
// here and shown once, to the owner's signed-in session alone, as the console's Settings → Webhook asks for it. The old
// secret signs nothing from then on: a test send, and a message that was queued before the rotation and tried after it,
// are signed with the new one. The API token is refused it in the secret-write words, the old secret kept; a rotation with
// no webhook set is refused, and so is one with a body; one whose write fails leaves the old secret signing, after a
// restart too.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { call, cookieOf, scratch, secretWritePath, serve, withEnv } from "./support.mjs";
import { meetsDocument, PRIVATE_OK, receiver, verifies, webhookOn } from "./webhook-support.mjs";

// The rotation is a secret write: the test client sends it from the owner's session, as the console does.
secretWritePath(["POST"], /^\/settings\/webhook\/secret$/);

const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
/** A test password, no real one: one of the source export's declared fakes, and 12 characters, the owner's minimum. */
const PASSWORD = "not-a-secret";
const REFUSAL = "Saving, replacing or removing a secret takes the owner's signed-in session in the console; the API token can't write secrets.";

/** A server with accounts on, its owner's password set: the token's client (`api`), the owner's session (`page`) and the
 *  API token itself (`token`). */
async function owned(t, options = {}) {
  withEnv(t, SEAL);
  const server = await serve(t, { accounts: true, openSetup: true, ...options });
  const origin = `http://127.0.0.1:${server.port}`;
  const set = await call(server.port, { method: "POST", path: "/v2/setup", headers: { "content-type": "application/json", origin }, body: { password: PASSWORD } });
  assert.equal(set.status, 201, set.text);
  const cookie = cookieOf(set);
  const page = async (method, path, body, headers = {}) => {
    const res = await call(server.port, { method, path: `/v2${path}`, headers: { cookie, origin, ...(method === "GET" ? {} : { "content-type": "application/json" }), ...headers }, body });
    return { status: res.status, body: res.json ?? res.text, text: res.text };
  };
  const token = (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${server.token}` });
  return { ...server, page, token };
}

test("the owner's session rotates the webhook's secret: a new one, shown this once, with its metadata; a read shows none, and the old one signs nothing after", async (t) => {
  const hook = await receiver(t);
  const { api, page } = await owned(t, PRIVATE_OK);
  const saved = await page("PUT", "/settings/webhook", { url: hook.url });
  assert.equal(saved.status, 201, saved.text);
  const first = saved.body.signing_secret;
  assert.match(first, /^whsec_/);
  assert.equal((await page("POST", "/settings/webhook/test")).body.status_code, 200);
  assert.ok(verifies(first, hook.got[0]), "before the rotation, the first secret signs");

  const rotated = await page("POST", "/settings/webhook/secret");
  assert.equal(rotated.status, 200, rotated.text);
  const second = rotated.body.signing_secret;
  assert.match(second, /^whsec_[A-Za-z0-9+/]{43}=$/, "whsec_ and 32 bytes in base64");
  assert.notEqual(second, first);
  assert.deepEqual([rotated.body.configured, rotated.body.signing, rotated.body.secret.name, rotated.body.secret.set, rotated.body.secret.source], [true, "sealed", "webhook:outbound", true, "console"]);
  assert.ok(Date.parse(rotated.body.secret.changed_at) >= Date.parse(saved.body.secret.changed_at), "the secret's time is the rotation's");
  assert.equal(rotated.body.updated_at, saved.body.updated_at, "the webhook itself is unchanged: its URL and when it was set");
  await meetsDocument(api, "/settings/webhook/secret", "post", "200", rotated.body);

  const read = await api("GET", "/settings/webhook");
  assert.ok(!JSON.stringify(read.body).includes("whsec_"), "no read shows it again");
  assert.deepEqual(read.body.secret, rotated.body.secret);

  assert.equal((await page("POST", "/settings/webhook/test")).body.status_code, 200);
  const after = hook.got[1];
  assert.ok(verifies(second, after), "after the rotation, the new secret signs");
  assert.ok(!verifies(first, after), "and the old one signs nothing");
});

test("the API token is refused a rotation in the secret-write words, and the secret it would replace still signs", async (t) => {
  const hook = await receiver(t);
  const { page, token } = await owned(t, PRIVATE_OK);
  const first = (await page("PUT", "/settings/webhook", { url: hook.url })).body.signing_secret;
  const refused = await token("POST", "/settings/webhook/secret");
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.ok(JSON.stringify(refused.body).includes(REFUSAL), JSON.stringify(refused.body));
  assert.ok(!JSON.stringify(refused.body).includes("whsec_"));
  assert.equal((await page("POST", "/settings/webhook/test")).body.status_code, 200);
  assert.ok(verifies(first, hook.got[0]), "the secret is kept");
});

test("a rotation with no webhook set is refused (404), and so is one with a body (422), before anything rotates", async (t) => {
  const { page } = await owned(t);
  const none = await page("POST", "/settings/webhook/secret");
  assert.equal(none.status, 404, none.text);
  assert.equal(none.body.error.code, "not_found");
  assert.match(none.body.error.message, /no webhook is set/);
  const saved = await page("PUT", "/settings/webhook", { url: "https://hooks.example.com/agentrun" });
  assert.equal(saved.status, 201, saved.text);
  const withBody = await page("POST", "/settings/webhook/secret", {});
  assert.equal(withBody.status, 422, withBody.text);
  const read = await page("GET", "/settings/webhook");
  assert.equal(read.body.secret.changed_at, saved.body.secret.changed_at, "nothing rotated");
});

test("a message queued before the rotation and tried again after it is signed with the new secret, under the same webhook-id", async (t) => {
  // The first try is held at the receiver until the rotation has landed, then answered 503: its retry comes after.
  let answerFirst;
  const held = new Promise((resolve) => (answerFirst = resolve));
  const hook = await receiver(t, (n) => (n === 1 ? held.then(() => 503) : 200));
  const dir = await scratch(t);
  const on = await webhookOn(t, dir, { retryMs: [20] });
  await on.runs("run_1");
  const webhooks = await on.open();
  const { secret: first } = await webhooks.save({ url: hook.url });
  const run = { run_id: "run_1", agent_id: "a", status: "completed", title: "t" };
  assert.equal(await webhooks.emit("run.ended", run, new Date().toISOString()), "queued");
  await hook.when(1, "the first try", dir);
  const { secret: second } = await webhooks.rotate();
  assert.notEqual(second, first);
  answerFirst();
  await hook.when(2, "the retry after the rotation", dir);
  const [before, after] = hook.got;
  assert.equal(after.headers["webhook-id"], before.headers["webhook-id"], "the same message");
  assert.ok(verifies(first, before), "the try before the rotation was signed with the old secret");
  assert.ok(verifies(second, after), "the try after it is signed with the new one");
  assert.ok(!verifies(first, after), "and not with the old one");
  assert.deepEqual(webhooks.signingSecrets().sort(), [first, second].sort(), "the old one is kept retired, still cut from what runs say");
});

test("a rotation whose setting was put but not flushed fails, and the old secret still signs, after a restart too", async (t) => {
  const hook = await receiver(t);
  const dir = await scratch(t);
  // Once armed, the store takes the next put of the webhook's setting (the one naming the new secret), then fails the
  // flush after it, once: the write's outcome is unknown, and the setting is in the store.
  let armed = false;
  let failFlush = false;
  const flaky = (store) => new Proxy(store, {
    get: (target, name) => {
      if (name === "flush") return async () => { if (failFlush) { failFlush = false; throw new Error("the store could not flush"); } return target.flush(); };
      if (name === "settings") return { ...target.settings, put: async (key, value) => { await target.settings.put(key, value); if (armed && key === "webhook-out") (armed = false, failFlush = true); } };
      const value = Reflect.get(target, name, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const on = await webhookOn(t, dir, { wrap: flaky });
  const webhooks = await on.open();
  const { secret: first } = await webhooks.save({ url: hook.url });
  armed = true;
  await assert.rejects(webhooks.rotate(), /the store could not flush/);
  assert.equal(webhooks.view().signing, "sealed");
  assert.equal((await webhooks.test()).status_code, 200);
  assert.ok(verifies(first, hook.got[0]), "the failed rotation left the old secret signing");
  await webhooks.close();

  const restarted = await on.open();
  assert.equal(restarted.view().signing, "sealed", "after a restart the setting names a secret that opens here");
  assert.equal((await restarted.test()).status_code, 200);
  assert.ok(verifies(first, hook.got[1]), "and it is still the old one, the one the receiver holds");
});
