// Settings → Computers and the owner's Archil settings on a served server, as the switch wires them (server.ts): under
// --faux (every served test's), the registry is faux-computers.ts's three providers. GET /v2/computers lists them, a
// saved key makes faux-sandbox ready, faux-broken's test says why, capabilities.features.computers names the offered
// kinds, the Archil routes turn Mode 2 on and off, and the run's desktop view, take-over and hand-back refuse in words
// until their store-backed work lands. A faux desktop's page is served only by a live faux desktop. No provider is called.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { FAUX_VIEW_PATH } from "../dist/faux-computers.js";
import { SECRET_WRITE_PATHS, serve as served, withEnv } from "./support.mjs";

// A computer key's save and any PUT of the Archil settings are secret writes (computers.ts, archil-routes.ts), and a run's
// live computer view is a full-control credential (server.ts getRunComputer): the client sends all three from the owner's
// session, as the console does, and the token is refused them (secret-writes-computers.test.mjs, owner-auth.test.mjs).
SECRET_WRITE_PATHS.push({ methods: ["PUT"], path: /^\/computers\/[^/]+\/keys$/ }, { methods: ["PUT"], path: /^\/workspace\/archil$/ }, { methods: ["GET"], path: /^\/runs\/[^/]+\/computer$/ });

/** A served server with a seal key, so it keeps the keys it is given, and an owner its client signs in as on its first
 *  secret write. */
async function serve(t, options) {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  return served(t, { ...options, accounts: true, openSetup: true });
}

test("served under --faux: the three faux providers, a key that makes faux-sandbox ready, faux-broken's words", async (t) => {
  const { api } = await serve(t, { runner: false });
  const listed = await api("GET", "/computers");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.kinds.flatMap((kind) => kind.providers.map((one) => `${kind.kind}:${one.id}`)), ["sandbox:faux-sandbox", "sandbox:faux-broken", "desktop:faux-desktop"]);
  const saved = await api("PUT", "/computers/faux-sandbox/keys", { FAUX_SANDBOX_KEY: "any-value-1" });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.ready, saved.body.secrets[0].name, saved.body.secrets[0].set, saved.body.secrets[0].source], [true, "computer:faux-sandbox:FAUX_SANDBOX_KEY", true, "console"]);
  assert.ok(!JSON.stringify(saved.body).includes("any-value-1"), "never echoed");
  assert.deepEqual((await api("POST", "/computers/faux-sandbox/test")).body, { ok: true, detail: "Faux sandbox: the faux account answered (no computer was made)" });
  const broken = await api("POST", "/computers/faux-broken/test");
  assert.equal(broken.body.ok, false);
  assert.match(broken.body.why, /^Faux broken could not be reached/);
  assert.equal((await api("PUT", "/computers/nobody/keys", {})).status, 404);
  assert.equal((await api("PUT", "/computers/faux-sandbox/keys", { OPENAI_API_KEY: "sk" })).status, 422);
});

test("served: capabilities.features.computers names the kinds offered now", async (t) => {
  const { api } = await serve(t, { runner: false });
  assert.deepEqual((await api("GET", "/capabilities")).body.features.computers, { kinds: ["none", "sandbox", "desktop"] });
});

test("served: the Archil routes turn Mode 2 on and off, never echoing the key", async (t) => {
  const { api } = await serve(t, { runner: false });
  assert.deepEqual((await api("GET", "/workspace/archil")).body, { on: false, secret: { name: "workspace:archil", set: false, source: null, changed_at: null } });
  const on = await api("PUT", "/workspace/archil", { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.archil.example", keys: { ARCHIL_API_KEY: "fake-test-key" } });
  assert.equal(on.status, 200);
  assert.deepEqual([on.body.on, on.body.secret.set], [true, true]);
  assert.ok(!JSON.stringify(on.body).includes("fake-test-key"));
  assert.equal((await api("PUT", "/workspace/archil", { diskId: "d", region: "r", s3Url: "https://s3.archil.example", keys: { ARCHIL_DISK_TOKEN: "x" } })).status, 422);
  assert.equal((await api("DELETE", "/workspace/archil")).body.on, false);
});

test("served handed no seal key: the server makes its own at the start (seal-key.ts) and keeps a computer key and the Archil account key under it", async (t) => {
  withEnv(t, {}, ["AGENTRUN_SEAL_KEY"]);
  const { api } = await served(t, { runner: false, accounts: true, openSetup: true });
  const saved = await api("PUT", "/computers/faux-sandbox/keys", { FAUX_SANDBOX_KEY: "any-value-2" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.ready, saved.body.secrets[0].set, saved.body.secrets[0].source], [true, true, "console"]);
  assert.deepEqual((await api("POST", "/computers/faux-sandbox/test")).body, { ok: true, detail: "Faux sandbox: the faux account answered (no computer was made)" }, "the saved key opens under the key the server made");
  const on = await api("PUT", "/workspace/archil", { diskId: "dsk-00000000000fake0", region: "aws-us-east-1", s3Url: "https://s3.archil.example", keys: { ARCHIL_API_KEY: "fake-test-key" } });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.deepEqual([on.body.on, on.body.secret.set], [true, true]);
});

test("served: a run's desktop view, take-over and hand-back refuse in words until the store-backed take-over lands; a faux page exists only for a live faux desktop", async (t) => {
  const { api, baseUrl, token } = await serve(t, { runner: false });
  const view = await api("GET", "/runs/run-404/computer");
  assert.equal(view.status, 404, "no run, read from the owner's session");
  const byToken = await fetch(`${baseUrl}/runs/run-404/computer`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(byToken.status, 403, "the token never reads a run's live computer view, a run or none");
  const page = await fetch(`${new URL(baseUrl).origin}${FAUX_VIEW_PATH}/faux-desktop-1/view`);
  assert.equal(page.status, 404, "no faux desktop was started");
});
