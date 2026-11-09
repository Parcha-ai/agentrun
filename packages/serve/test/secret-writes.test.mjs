// A secret is written only from the owner's session (secret-writes.ts): with accounts on, the owner's password session;
// with accounts off on a server bound to loopback alone, the console the launch link opened (decided). The server's API
// token, which a run's process, an agent's MCP client or a script may hold, never saves, replaces or removes one, on any
// server. One check in the server's dispatch decides it by the operation and its body (each plane registers which body
// fields are secrets), in one refusal text. GET /v2/auth/session says whether this browser may (secrets_writable), and if
// not, why (secrets_reason: sign_in, no_accounts, token), from the same one decision.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { test } from "node:test";
import { call, cookieOf, serve, withEnv } from "./support.mjs";

const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
const json = { "content-type": "application/json" };
const phrase = () => `owner-${randomBytes(12).toString("hex")}`;
const planted = () => `not-a-secret-${randomBytes(12).toString("hex")}`;

/** The module under test, or undefined before it exists (the red run). */
async function secretWrites() {
  try {
    return await import("../dist/secret-writes.js");
  } catch {
    return undefined;
  }
}

/** The owner's password session on `server` (accounts on): its password set, and the cookie the setup gave. */
async function ownerSession(server) {
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: phrase() } });
  assert.equal(setup.status, 201, setup.text);
  return { cookie: cookieOf(setup), origin };
}

/** A request to `host`:`port` (call() is loopback's): status, text and parsed JSON. */
function at(host, port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, method, path, headers: { host: `${host}:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk)).on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
      });
    });
    req.once("error", reject).end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** The accounts-off console's session (the launch link's cookie: GET /?token=), on `host`:`port`. */
async function launchSession(host, port, token) {
  const link = await at(host, port, { path: `/?token=${token}` });
  assert.equal(link.status, 303, `the launch link sets the console's cookie: ${link.text}`);
  return { cookie: cookieOf(link), origin: `http://${host}:${port}` };
}

test("the one decision: the owner's password session writes; the accounts-off console only on a loopback-bound server and only with the switch on; the token never", async () => {
  const mod = await secretWrites();
  assert.ok(mod, "secret-writes.js exists");
  const facts = (over) => ({ accounts: false, passwordSession: false, consoleSession: false, token: false, loopbackBound: true, ...over });
  for (const owner of [true, false]) {
    const at = (over) => mod.secretWriteVerdict(facts(over), owner);
    assert.deepEqual(at({ accounts: true, passwordSession: true }), { writable: true }, `${owner}: the owner's password session`);
    assert.deepEqual(at({ accounts: true, token: true }), { writable: false, reason: "token" }, `${owner}: the token, accounts on`);
    assert.deepEqual(at({ token: true }), { writable: false, reason: "token" }, `${owner}: the token, accounts off on loopback`);
    assert.deepEqual(at({ accounts: true }), { writable: false, reason: "sign_in" }, `${owner}: accounts on, no session`);
    assert.deepEqual(at({ consoleSession: true, loopbackBound: false }), { writable: false, reason: "no_accounts" }, `${owner}: accounts off, off loopback`);
    assert.deepEqual(at({ consoleSession: true }), owner ? { writable: true } : { writable: false, reason: "sign_in" }, `${owner}: the accounts-off loopback console follows the switch`);
  }
  assert.equal(mod.LOOPBACK_CONSOLE_IS_OWNER, true, "decided: the loopback console is the owner");
});

test("accounts on: the owner's password session saves and removes a tool key and a model key; the token is refused in the one text", async (t) => {
  withEnv(t, SEAL);
  const server = await serve(t, { runner: false, accounts: true, openSetup: true });
  const mod = await secretWrites();
  assert.ok(mod, "secret-writes.js exists");
  const { cookie, origin } = await ownerSession(server);
  const bearer = { authorization: `Bearer ${server.token}` };
  for (const [id, field] of [["monid", "MONID_API_KEY"], ["openrouter", "OPENROUTER_API_KEY"]]) {
    const value = planted();
    const byToken = await call(server.port, { method: "PUT", path: `/v2/settings/tool-keys/${id}`, headers: { ...json, ...bearer }, body: { values: { [field]: value } } });
    assert.equal(byToken.status, 403, `${id}: the token is refused: ${byToken.text}`);
    assert.equal(byToken.json?.error?.message, mod.SECRET_WRITE_REFUSAL, `${id}: in the one refusal text`);
    assert.equal(byToken.text.includes(value), false, `${id}: the refusal never echoes the value`);
    const listed = await server.api("GET", "/settings/tool-keys");
    assert.equal(JSON.stringify(listed.body).includes(value), false, `${id}: nothing was kept`);
    const bySession = await call(server.port, { method: "PUT", path: `/v2/settings/tool-keys/${id}`, headers: { ...json, cookie, origin }, body: { values: { [field]: value } } });
    assert.equal(bySession.status, 204, `${id}: the owner's session saves it: ${bySession.text}`);
    const removeByToken = await call(server.port, { method: "DELETE", path: `/v2/settings/tool-keys/${id}`, headers: bearer });
    assert.equal(removeByToken.status, 403, `${id}: the token can't remove it either: ${removeByToken.text}`);
    assert.equal(removeByToken.json?.error?.message, mod.SECRET_WRITE_REFUSAL, `${id}: in the one refusal text`);
    const removeBySession = await call(server.port, { method: "DELETE", path: `/v2/settings/tool-keys/${id}`, headers: { ...json, cookie, origin } });
    assert.equal(removeBySession.status, 204, `${id}: the owner's session removes it: ${removeBySession.text}`);
  }
});

test("accounts on: GET /v2/auth/session answers accounts, secrets_writable, and secrets_reason (sign_in, token) only when it is false", async (t) => {
  withEnv(t, SEAL);
  const server = await serve(t, { runner: false, accounts: true, openSetup: true });
  const before = await call(server.port, { path: "/v2/auth/session" });
  assert.deepEqual([before.json?.accounts, before.json?.secrets_writable, before.json?.secrets_reason], [true, false, "sign_in"], `no session: ${before.text}`);
  const { cookie, origin } = await ownerSession(server);
  const signedIn = await call(server.port, { path: "/v2/auth/session", headers: { cookie, origin } });
  assert.deepEqual([signedIn.json?.accounts, signedIn.json?.secrets_writable], [true, true], `the owner's session: ${signedIn.text}`);
  assert.equal("secrets_reason" in (signedIn.json ?? {}), false, "no reason when it may");
  const byToken = await call(server.port, { path: "/v2/auth/session", headers: { authorization: `Bearer ${server.token}` } });
  assert.deepEqual([byToken.json?.secrets_writable, byToken.json?.secrets_reason], [false, "token"], `the token: ${byToken.text}`);
});

test("accounts off on loopback: the launch link's console saves a tool key, and its session says so; the token is refused, and its session says token", async (t) => {
  withEnv(t, SEAL);
  const server = await serve(t, { runner: false });
  const mod = await secretWrites();
  assert.ok(mod, "secret-writes.js exists");
  const { cookie, origin } = await launchSession("127.0.0.1", server.port, server.token);
  const session = await call(server.port, { path: "/v2/auth/session", headers: { cookie } });
  assert.equal(session.status, 200, `it answers with accounts off: ${session.text}`);
  assert.deepEqual(session.json, { accounts: false, secrets_writable: true }, "the launch link's console may; no user field");
  const saved = await call(server.port, { method: "PUT", path: "/v2/settings/tool-keys/monid", headers: { ...json, cookie, origin }, body: { values: { MONID_API_KEY: planted() } } });
  assert.equal(saved.status, 204, `the launch link's console saves it: ${saved.text}`);
  const byToken = await call(server.port, { method: "PUT", path: "/v2/settings/tool-keys/monid", headers: { ...json, authorization: `Bearer ${server.token}` }, body: { values: { MONID_API_KEY: planted() } } });
  assert.equal(byToken.status, 403, `the token never saves one, loopback included: ${byToken.text}`);
  assert.equal(byToken.json?.error?.message, mod.SECRET_WRITE_REFUSAL);
  const tokenSession = await call(server.port, { path: "/v2/auth/session", headers: { authorization: `Bearer ${server.token}` } });
  assert.deepEqual(tokenSession.json, { accounts: false, secrets_writable: false, secrets_reason: "token" });
  const stranger = await call(server.port, { path: "/v2/auth/session" });
  assert.deepEqual(stranger.json, { accounts: false, secrets_writable: false, secrets_reason: "sign_in" }, "a browser that didn't follow the launch link");
});

test("accounts off on a server bound off loopback: its console session is refused every secret write, and its session says no_accounts", async (t) => {
  // An address of this machine's own that is not loopback, read here (none in the code); skipped on a machine with none.
  const host = Object.values(networkInterfaces()).flat().find((nic) => nic && nic.family === "IPv4" && !nic.internal)?.address;
  if (!host) return t.skip("this machine has no address off loopback");
  withEnv(t, SEAL);
  const mod = await secretWrites();
  assert.ok(mod, "secret-writes.js exists");
  const server = await serve(t, { runner: false, host });
  const { cookie, origin } = await launchSession(host, server.port, server.token);
  const session = await at(host, server.port, { path: "/v2/auth/session", headers: { cookie } });
  assert.deepEqual(session.json, { accounts: false, secrets_writable: false, secrets_reason: "no_accounts" }, `off loopback: ${session.text}`);
  const refused = await at(host, server.port, { method: "PUT", path: "/v2/settings/tool-keys/monid", headers: { ...json, cookie, origin }, body: { values: { MONID_API_KEY: planted() } } });
  assert.equal(refused.status, 403, `the console session is refused off loopback: ${refused.text}`);
  assert.equal(refused.json?.error?.message, mod.SECRET_WRITE_REFUSAL);
});

test("the gate decides by the operation's body: a route no plane registered (a token's tool-settings edit) is not a secret write", async (t) => {
  withEnv(t, SEAL);
  const server = await serve(t, { runner: false, accounts: true, openSetup: true });
  const mod = await secretWrites();
  assert.ok(mod, "secret-writes.js exists");
  assert.equal(mod.writesSecret("putToolSettings", { web_fetch: { permission: "ask" } }), false, "no plane registered it");
  assert.equal(mod.writesSecret("saveToolKey", { values: { MONID_API_KEY: planted() } }), true, "a tool key's value is a secret");
  assert.equal(mod.writesSecret("deleteToolKey", undefined), true, "removing a tool key is a secret write");
  assert.equal((await server.api("PUT", "/settings/tools", { web_fetch: { permission: "ask" } })).status, 200, "the token still edits tool settings");
  // A plane registers its own predicate: by body fields, not by route.
  mod.registerSecretWrite("testOnlyOperation", (body) => typeof body?.secret === "string");
  assert.equal(mod.writesSecret("testOnlyOperation", { name: "x" }), false, "a body with no secret field is no secret write");
  assert.equal(mod.writesSecret("testOnlyOperation", { secret: planted() }), true, "one with it is");
});
