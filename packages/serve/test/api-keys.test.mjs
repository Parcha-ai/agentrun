// The API keys a person makes in the console (Settings → AgentRun API keys, /v2/settings/api-keys, api-keys.ts): a key
// is made by the owner's signed-in session alone, shown once in the answer that made it, and opens /v2 and /mcp as the
// server's own token does, from then until it is revoked, across a restart too. No read shows it again; the store keeps
// a keyed hash of it and never the key; a token, or a key, is refused making or revoking one; and a key is never the
// setup code. The keys over the store alone, on SQLite and on Postgres, are api-keys-store.test.mjs's.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { test } from "node:test";
import { findPlanted } from "./fixtures/planted-secrets.mjs";
import { asOwner, call, client, cookieOf, launchFor, serve, withEnv } from "./support.mjs";
import { meetsDocument } from "./webhook-support.mjs";

const { API_KEY_PREFIX, API_KEY_SETTING, API_KEYS_LIMIT } = await import("../dist/api-keys.js");
const { CLAUDE_LOGIN_SETTING, LOGIN_REFUSES_API_KEYS } = await import("../dist/claude-login.js");
const { HARNESS_SIGN_IN_REFUSES_API_KEYS } = await import("../dist/server.js");

const SEAL = { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") };
/** A test password, no real one: one of the source export's declared fakes, and 12 characters, the owner's minimum. */
const PASSWORD = "not-a-secret";
const REFUSAL = "Saving, replacing or removing a secret takes the owner's signed-in session in the console; the API token can't write secrets.";
const KEY = new RegExp(`^${API_KEY_PREFIX}[A-Za-z0-9_-]{43}$`);

/** A server with accounts on, its owner's password set: the owner's session (`page`), the API token itself (`token`)
 *  and a caller with any Bearer (`as`). */
async function owned(t, options = {}) {
  withEnv(t, SEAL);
  const server = await serve(t, { accounts: true, openSetup: true, runner: false, ...options });
  const origin = `http://127.0.0.1:${server.port}`;
  const set = await call(server.port, { method: "POST", path: "/v2/setup", headers: { "content-type": "application/json", origin }, body: { password: PASSWORD } });
  assert.equal(set.status, 201, set.text);
  const cookie = cookieOf(set);
  const page = async (method, path, body) => {
    const res = await call(server.port, { method, path: `/v2${path}`, headers: { cookie, origin, ...(method === "GET" ? {} : { "content-type": "application/json" }) }, body });
    return { status: res.status, body: res.json ?? res.text, text: res.text };
  };
  const as = (bearer) => (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${bearer}` });
  return { ...server, page, token: as(server.token), as };
}

/** One request to the server's MCP endpoint with `bearer`: its status. */
async function mcpStatus(server, bearer) {
  const res = await fetch(`${server.baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });
  await res.text();
  return res.status;
}

/** Every row the store keeps for the API keys, as text. */
const keptRows = async (server) => (await server.store.settings.all({ prefix: API_KEY_SETTING })).map((row) => ({ where: row.key, text: JSON.stringify(row) }));

test("the owner's session makes a key, shown this once; it opens /v2 and /mcp, and no read shows it again", async (t) => {
  const lines = [];
  const server = await owned(t, { log: (line) => lines.push(line) });
  assert.deepEqual((await server.token("GET", "/settings/api-keys")).body, { keys: [], limit: API_KEYS_LIMIT }, "none at first, read with the token");

  const made = await server.page("POST", "/settings/api-keys", { name: "  billing app " });
  assert.equal(made.status, 201, made.text);
  assert.match(made.body.api_key, KEY, "ar_key_ and 32 random bytes in base64url");
  assert.equal(made.body.name, "billing app", "the name, trimmed");
  assert.equal(made.body.last_used_at, null);
  assert.deepEqual(made.body.secret, { name: `api-key:${made.body.id}`, set: true, source: "console", changed_at: made.body.created_at });
  await meetsDocument(server.api, "/settings/api-keys", "post", "201", made.body);

  const key = made.body.api_key;
  lines.length = 0;
  assert.equal((await server.as(key)("GET", "/agents")).status, 200, "the key opens /v2");
  assert.equal(await mcpStatus(server, key), 200, "and /mcp");
  const named = lines.filter((line) => / event=request /.test(line) && line.includes(" path=/v2/agents "));
  assert.equal(named.length, 1, lines.join("\n"));
  assert.match(named[0], new RegExp(` api_key=${made.body.id}( |$)`), "the request line names the key's id");
  assert.ok(lines.every((line) => !line.includes(key)), "no log line holds the key");

  const read = await server.as(key)("GET", "/settings/api-keys");
  assert.equal(read.status, 200);
  await meetsDocument(server.api, "/settings/api-keys", "get", "200", read.body);
  const { api_key: _shown, last_used_at: _none, ...view } = made.body;
  const { last_used_at: used, ...listed } = read.body.keys[0];
  assert.deepEqual([read.body.keys.length, listed], [1, view], "the list shows what the create answered, less the key");
  assert.ok(Date.parse(used) >= Date.parse(made.body.created_at), "and when it was last used");
  assert.deepEqual(findPlanted([{ where: "GET /settings/api-keys", text: JSON.stringify(read.body) }, ...(await keptRows(server))], [key]), [], "no read and no store row holds the key, in any form");

  const caps = (await server.api("GET", "/capabilities")).body;
  assert.deepEqual(caps.features.api_keys, { routes: true, limit: API_KEYS_LIMIT, at_rest: "hashed" });
});

test("a token, and a key itself, is refused making or revoking a key, in the secret-write words, with the console's page", async (t) => {
  const server = await owned(t);
  const made = await server.page("POST", "/settings/api-keys", { name: "ci" });
  assert.equal(made.status, 201, made.text);
  for (const [who, caller] of [["the token", server.token], ["a key", server.as(made.body.api_key)]]) {
    for (const [method, path, body] of [["POST", "/settings/api-keys", { name: "another" }], ["DELETE", `/settings/api-keys/${made.body.id}`, undefined]]) {
      const refused = await caller(method, path, body);
      assert.equal(refused.status, 403, `${who}: ${method} ${path}`);
      assert.equal(refused.body.error.code, "forbidden");
      assert.ok(refused.body.error.message.startsWith(REFUSAL), refused.body.error.message);
      assert.match(refused.body.error.details.console_url, /\/#\/settings\/api-keys$/, "where the owner does it");
    }
  }
  const listed = (await server.token("GET", "/settings/api-keys")).body.keys;
  assert.deepEqual(listed.map((one) => one.id), [made.body.id], "none was made, and the one there was kept");
  assert.equal((await server.as(made.body.api_key)("GET", "/agents")).status, 200, "and it still opens");
  assert.equal((await client(server.baseUrl)("POST", "/settings/api-keys", { name: "anyone" })).status, 401, "no credential at all is 401");
});

test("a revoked key opens nothing from then on; a second revocation is 404", async (t) => {
  const server = await owned(t);
  const [kept, gone] = await Promise.all(["kept", "gone"].map(async (name) => (await server.page("POST", "/settings/api-keys", { name })).body));
  assert.notEqual(kept.api_key, gone.api_key);
  assert.equal((await server.as(gone.api_key)("GET", "/agents")).status, 200);

  const revoked = await server.page("DELETE", `/settings/api-keys/${gone.id}`);
  assert.equal(revoked.status, 204, revoked.text);
  const after = await server.as(gone.api_key)("GET", "/agents");
  assert.equal(after.status, 401, "the revoked key is refused");
  assert.equal(after.body.error.code, "unauthenticated");
  assert.equal(await mcpStatus(server, gone.api_key), 401, "on /mcp too");
  assert.equal((await server.as(kept.api_key)("GET", "/agents")).status, 200, "the other key still opens");
  assert.deepEqual((await server.token("GET", "/settings/api-keys")).body.keys.map((one) => one.name), ["kept"]);
  assert.deepEqual(await keptRows(server).then((rows) => rows.map((row) => row.where)), [`${API_KEY_SETTING}${kept.id}`], "its row is gone from the store");

  const again = await server.page("DELETE", `/settings/api-keys/${gone.id}`);
  assert.equal(again.status, 404);
  assert.equal(again.body.error.code, "not_found");
});

test("a key opens after a restart, and a revoked one does not", async (t) => {
  const server = await owned(t);
  const [kept, gone] = await Promise.all(["kept", "gone"].map(async (name) => (await server.page("POST", "/settings/api-keys", { name })).body));
  assert.equal((await server.as(kept.api_key)("GET", "/agents")).status, 200);
  assert.equal((await server.page("DELETE", `/settings/api-keys/${gone.id}`)).status, 204);
  await server.stop();

  const again = await serve(t, { data: server.data, accounts: true, runner: false });
  const as = (bearer) => client(again.baseUrl, bearer);
  assert.equal((await as(kept.api_key)("GET", "/agents")).status, 200, "the key made before the restart opens");
  assert.equal((await as(gone.api_key)("GET", "/agents")).status, 401, "the one revoked before it does not");
  const listed = (await as(again.token)("GET", "/settings/api-keys")).body.keys;
  assert.deepEqual(listed.map((one) => [one.id, one.name]), [[kept.id, "kept"]]);
  assert.ok(Date.parse(listed[0].last_used_at) >= Date.parse(kept.created_at), "its last use was written before the stop");
});

test("a row written without the server's seal key opens nothing, and is said once at the start", async (t) => {
  const server = await owned(t);
  const forged = `${API_KEY_PREFIX}${"f".repeat(43)}`;
  const id = "01a20b30-b53a-7000-9abd-64340ac132cb";
  // What a writer with the store alone could do: a plain digest of the key it wants taken.
  await server.store.settings.put(`${API_KEY_SETTING}${id}`, { v: 1, id, name: "forged", mac: createHash("sha256").update(`Bearer ${forged}`).digest("hex"), created_at: new Date().toISOString(), last_used_at: null });
  await server.store.settings.put(`${API_KEY_SETTING}not-a-key`, { v: 7 });
  await server.stop();

  const lines = [];
  const again = await serve(t, { data: server.data, accounts: true, runner: false, log: (line) => lines.push(line) });
  assert.equal((await client(again.baseUrl, forged)("GET", "/agents")).status, 401, "the forged key is refused");
  const said = lines.filter((line) => line.includes("condition=api_key_unreadable"));
  assert.equal(said.length, 1, lines.join("\n"));
  assert.match(said[0], new RegExp(`key=${API_KEY_SETTING}not-a-key`), "the row that is no key's is named, by its store key");
});

test("a key is never the setup code: only a token the server was started with sets the first password", async (t) => {
  // With no accounts, on loopback, the launch link's console makes the key (secret-writes.ts).
  const first = launchFor(await serve(t, { runner: false }));
  const made = await asOwner(first)("POST", "/settings/api-keys", { name: "from before accounts" });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const key = made.body.api_key;
  await first.stop();

  const server = await serve(t, { data: first.data, accounts: true, runner: false });
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = (headers, body) => call(server.port, { method: "POST", path: "/v2/setup", headers: { "content-type": "application/json", origin, ...headers }, body });
  assert.equal((await client(server.baseUrl, key)("GET", "/agents")).status, 200, "the key is an API key here still");
  const asBearer = await setup({ authorization: `Bearer ${key}` }, { password: PASSWORD });
  assert.equal(asBearer.status, 401, `as the setup's Bearer: ${asBearer.text}`);
  const asCode = await setup({}, { password: PASSWORD, code: key });
  assert.equal(asCode.status, 403, `as the setup code: ${asCode.text}`);
  const byToken = await setup({ authorization: `Bearer ${server.token}` }, { password: PASSWORD });
  assert.equal(byToken.status, 201, `the server's own token still sets it: ${byToken.text}`);
});

test("an API-only server takes no key made before the profile: it has no owner, and no route to revoke one", async (t) => {
  const first = await owned(t);
  const made = await first.page("POST", "/settings/api-keys", { name: "from before the profile" });
  assert.equal(made.status, 201, made.text);
  assert.equal((await first.as(made.body.api_key)("GET", "/runs")).status, 200);
  await first.stop();

  const server = await serve(t, { data: first.data, apiOnly: true, runner: false });
  assert.equal((await client(server.baseUrl, server.token)("GET", "/runs")).status, 200, "the token it was started with opens it");
  assert.equal((await client(server.baseUrl, made.body.api_key)("GET", "/runs")).status, 401, "the key does not");
  assert.equal((await client(server.baseUrl, server.token)("GET", "/settings/api-keys")).status, 404, "and the keys' routes are not served");
  assert.deepEqual((await client(server.baseUrl, server.token)("GET", "/capabilities")).body.features.api_keys, { routes: false, limit: API_KEYS_LIMIT, at_rest: "hashed" }, "its capabilities say so");
  await server.stop();

  const back = await serve(t, { data: first.data, accounts: true, runner: false });
  assert.equal((await client(back.baseUrl, made.body.api_key)("GET", "/runs")).status, 200, "without the profile it opens again: its row was kept");
});

test("one owner: a server with Claude Code's login on makes no key, and one with a key refuses the login, each in words", async (t) => {
  const server = await owned(t);
  // The login on, as its PUT saves it (claude-login.ts), with no CLI asked: the rule reads the setting alone.
  const on = { v: 1, place: "agentrun", host: hostname(), only_me: true };
  await server.store.settings.put(CLAUDE_LOGIN_SETTING, on);
  assert.equal((await server.token("GET", "/settings/api-keys")).body.refused, LOGIN_REFUSES_API_KEYS, "the list says why none is made");
  const refused = await server.page("POST", "/settings/api-keys", { name: "an app on a personal plan" });
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.body.error.message, LOGIN_REFUSES_API_KEYS);
  assert.deepEqual((await server.token("GET", "/settings/api-keys")).body.keys, [], "and none was made");

  // The login off: a key is made, and the login is then refused the other way.
  await server.store.settings.remove(CLAUDE_LOGIN_SETTING);
  const listed = (await server.token("GET", "/settings/api-keys")).body;
  assert.equal("refused" in listed, false);
  await meetsDocument(server.api, "/settings/api-keys", "get", "200", listed);
  const made = await server.page("POST", "/settings/api-keys", { name: "billing app" });
  assert.equal(made.status, 201, made.text);
  const words = "This server has an API key made for apps (Settings → AgentRun API keys), so more than one caller can start runs here: a Claude plan is one person's. Revoke it first.";
  const login = await server.page("PUT", "/settings/claude-login", { only_me: true });
  assert.equal(login.status, 403, login.text);
  assert.equal(login.body.error.message, words);
  const view = await server.page("GET", "/settings/claude-login");
  assert.deepEqual([view.body.state, view.body.refused, view.body.can_start], ["off", words, false], "its view says so before anyone tries");
  assert.equal(await server.store.settings.get(CLAUDE_LOGIN_SETTING), undefined, "the login was not turned on");

  // The key revoked: nothing refuses the login any more.
  assert.equal((await server.page("DELETE", `/settings/api-keys/${made.body.id}`)).status, 204);
  assert.equal("refused" in (await server.page("GET", "/settings/claude-login")).body, false);
});

test("a saved turn-on of Claude Code's login is dropped at a start that finds an API key, and said", async (t) => {
  const first = await owned(t);
  const made = await first.page("POST", "/settings/api-keys", { name: "billing app" });
  assert.equal(made.status, 201, made.text);
  // Both there at once, as no route leaves them: written past the routes.
  await first.store.settings.put(CLAUDE_LOGIN_SETTING, { v: 1, place: "agentrun", host: hostname(), only_me: true });
  await first.stop();

  const lines = [];
  const server = await serve(t, { data: first.data, accounts: true, runner: false, log: (line) => lines.push(line) });
  assert.equal(await server.store.settings.get(CLAUDE_LOGIN_SETTING), undefined, "the login's setting went");
  assert.ok(lines.some((line) => line.includes("event=claude_login") && line.includes("API key made for apps")), lines.join("\n"));
  assert.equal((await client(server.baseUrl, made.body.api_key)("GET", "/agents")).status, 200, "the key still opens");
});

test("a server started on its owner's own sign-in makes no key; one made before opens nothing there, and is listed so its owner revokes it", async (t) => {
  const first = await owned(t);
  const made = await first.page("POST", "/settings/api-keys", { name: "from before the sign-in" });
  assert.equal(made.status, 201, made.text);
  await first.stop();

  const server = launchFor(await serve(t, { data: first.data, harnessSignIn: true, runner: false }));
  assert.equal((await client(server.baseUrl, made.body.api_key)("GET", "/agents")).status, 401, "the key made before opens nothing here");
  const listed = (await client(server.baseUrl, server.token)("GET", "/settings/api-keys")).body;
  assert.deepEqual([listed.keys.map((one) => [one.id, one.name]), listed.refused], [[[made.body.id, "from before the sign-in"]], HARNESS_SIGN_IN_REFUSES_API_KEYS], "it is listed, with why it opens nothing");
  const refused = await asOwner(server)("POST", "/settings/api-keys", { name: "an app" });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error.message, HARNESS_SIGN_IN_REFUSES_API_KEYS);
  // While it is there, the login that is one person's is refused by it: no key waits unseen for a later start.
  const login = await asOwner(server)("PUT", "/settings/claude-login", { only_me: true });
  assert.equal(login.status, 403, JSON.stringify(login.body));
  assert.equal(login.body.error.message, "This server keeps an API key made for apps (Settings → AgentRun API keys). It opens nothing here, and would open the server at a start that takes keys again: a Claude plan is one person's. Revoke it first.");
  // Its owner revokes it here.
  assert.equal((await asOwner(server)("DELETE", `/settings/api-keys/${made.body.id}`)).status, 204);
  assert.deepEqual((await client(server.baseUrl, server.token)("GET", "/settings/api-keys")).body.keys, []);
  await server.stop();

  const back = await serve(t, { data: first.data, accounts: true, runner: false });
  assert.equal((await client(back.baseUrl, made.body.api_key)("GET", "/agents")).status, 401, "revoked while dormant, it opens nothing at a later start either");
});

test("a name is 1 to 64 characters on one line, and the body takes nothing else", async (t) => {
  const server = await owned(t);
  for (const [body, field] of [[{}, "name"], [{ name: 7 }, "name"], [{ name: "   " }, "name"], [{ name: "x".repeat(65) }, "name"], [{ name: "two\nlines" }, "name"], [{ name: "ok", scope: "all" }, "scope"]]) {
    const refused = await server.page("POST", "/settings/api-keys", body);
    assert.equal(refused.status, 422, JSON.stringify(body));
    assert.equal(refused.body.error.fields[0].field, field, JSON.stringify(refused.body.error));
  }
  assert.equal((await server.page("POST", "/settings/api-keys", { name: "x".repeat(64) })).status, 201, "64 characters is a name");
  assert.equal((await server.token("GET", "/settings/api-keys")).body.keys.length, 1, "no refused body made a key");
});

test(`a server keeps at most ${API_KEYS_LIMIT} keys: the next is 409 api_keys_full, and takes once one is revoked`, async (t) => {
  const server = await owned(t);
  const made = [];
  for (let i = 0; i < API_KEYS_LIMIT; i++) made.push((await server.page("POST", "/settings/api-keys", { name: `key ${i + 1}` })).body);
  assert.ok(made.every((one) => KEY.test(one.api_key)), "each was made");
  assert.equal(new Set(made.map((one) => one.api_key)).size, API_KEYS_LIMIT, "each its own");
  const full = await server.page("POST", "/settings/api-keys", { name: "one too many" });
  assert.equal(full.status, 409, full.text);
  assert.equal(full.body.error.code, "api_keys_full");
  assert.deepEqual((await server.token("GET", "/settings/api-keys")).body.keys.map((one) => one.name), made.map((one) => one.name), "listed oldest first");
  assert.equal((await server.page("DELETE", `/settings/api-keys/${made[0].id}`)).status, 204);
  assert.equal((await server.page("POST", "/settings/api-keys", { name: "now it fits" })).status, 201);
});
