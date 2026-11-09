// A secret is written only from the owner's signed-in session (secret-writes.ts): the server's API token, which a run's
// process, an agent's MCP client or a script may hold, can never save, replace or remove one. One check in the server's
// dispatch decides it by the operation and its body (each plane registers which body fields are secrets), in one refusal
// text. GET /v2/auth/session says whether this browser may write secrets (secrets_writable), for the console.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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

/** The owner's session on `server`: its password set, and the cookie the setup gave. */
async function ownerSession(server) {
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: phrase() } });
  assert.equal(setup.status, 201, setup.text);
  return { cookie: cookieOf(setup), origin };
}

test("the API token can never save, replace or remove a tool key or a model key: 403 in the one refusal text; the owner's session can", async (t) => {
  withEnv(t, SEAL);
  const server = await serve(t, { runner: false });
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
    const removeBySession = await call(server.port, { method: "DELETE", path: `/v2/settings/tool-keys/${id}`, headers: { ...json, cookie, origin }, body: {} });
    assert.equal(removeBySession.status, 204, `${id}: the owner's session removes it: ${removeBySession.text}`);
  }
});

test("the gate decides by the operation's body: a route no plane registered (a token's tool-settings edit) is not a secret write", async (t) => {
  withEnv(t, SEAL);
  const server = await serve(t, { runner: false });
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

test("GET /v2/auth/session answers secrets_writable: true on the owner's signed-in session, false without one", async (t) => {
  withEnv(t, SEAL);
  const server = await serve(t, { runner: false });
  const before = await call(server.port, { path: "/v2/auth/session" });
  assert.equal(before.json?.secrets_writable, false, `before any owner: ${before.text}`);
  const { cookie, origin } = await ownerSession(server);
  const signedIn = await call(server.port, { path: "/v2/auth/session", headers: { cookie, origin } });
  assert.equal(signedIn.json?.secrets_writable, true, `the owner's session: ${signedIn.text}`);
  const stranger = await call(server.port, { path: "/v2/auth/session", headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(stranger.json?.secrets_writable, false, `the token alone: ${stranger.text}`);
});
