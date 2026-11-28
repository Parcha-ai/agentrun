// MCP servers on an API-only server (AGENTRUN_API_ONLY=1), which has no owner: its token saves a Composio server through
// the preset and deletes a server, and never writes a secret; the saved servers' names are its one listing
// (GET /settings/mcp-server-names). A Composio save names its key by the server's own environment variable
// (`api_key_env: "COMPOSIO_API_KEY"`, the one name taken): the server keeps that name, never the value, and reads the value
// at each use (the save's own calls to Composio, a run's connection, the delete's), and only ever sends it to Composio's
// origin, whatever a stored row says. Its Composio save stands on nothing the owner's does: its users are kept at
// Composio under the token's own namespace (`agentrun.token.<user_id>`), it never uses an auth config a server the owner
// saved stands on, and an ACTIVE account it finds for its user must be one a server the token saved connected (every page
// of them, up to the lookup's bound). The token saves no server at an address or with headers of its own: the generic save,
// the list and the read stay refused there. The full profile is as before: its token's `api_key_env` is the one
// secret-write refusal. Fake Composio on loopback (fixtures/fake-composio.mjs, its MCP origin the composioMcpOrigin seam),
// the faux MCP model (fixtures/faux-mcp.mjs). No key, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { queued, registryPin, storeOn } from "./store-helpers.mjs";
import { asOwner, follow, serve, serverLog, storeBytes, withEnv } from "./support.mjs";

const { SECRET_WRITE_REFUSAL } = await import("../dist/secret-writes.js");
const { composioMadeKey, storedMade } = await import("../dist/composio-made.js");
const { mcpSourceKey, ownersRecord } = await import("../dist/mcp-sources.js");
const { mcpClaim } = await import("../dist/runner/mcp-claim.js");

const KEY_ENV = "COMPOSIO_API_KEY";
const KEY = `not-a-secret-${"composio-env-key-0001"}`;
const ROTATED = `not-a-secret-${"composio-env-key-0002"}`;
const OTHER = `not-a-secret-${"anthropic-env-key-0003"}`;
const OTHER_KEY = `not-a-secret-${"other-env-key-0004"}`;
const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const ADD = { slug: "add", name: "Add", description: "Add two numbers." };
const TOOLKITS = { gmail: { no_auth: false, tools: [ADD] } };
// A run's user on an API-only server is none the owner calls as here (one in the token's namespace is one such), and its
// account one Composio lists under it (api-only-composio-binding.test.mjs).
const USER_A = "agentrun.token.grep-user-alice-0001";
const ACCOUNT_A = "ca_alice_gmail_0001";
const MCP_ACCOUNTS = { [USER_A]: [ACCOUNT_A] };
const ACCOUNTS = { gmail: [{ status: "ACTIVE", auth_config: "ac_alice_own", id: ACCOUNT_A, user: USER_A }] };
const CALL = 'Call mcp__mail__add with {"a":2,"b":3}';
const SAVE = { api_key_env: KEY_ENV, toolkit: "gmail", tools: ["add"], user_id: "per_run" };
const PROJECT_KEY_ENV = "AGENTRUN_COMPOSIO_API_KEY";

/** A server (API-only unless `full`) beside a fake Composio whose key is KEY (`fake`: more of its options), and the log. */
async function setup(t, { full = false, fake = {} } = {}) {
  const composio = await startFakeComposio({ apiKey: KEY, toolkits: TOOLKITS, mcpAccounts: MCP_ACCOUNTS, accounts: ACCOUNTS, ...fake });
  t.after(() => composio.close());
  const log = serverLog(t);
  // The fake's MCP endpoint stands in for Composio's origin (composioMcpOrigin, the server's and runner's test-only seam).
  const server = await serve(t, { faux: FAUX_MCP, composioControl: { baseUrl: composio.baseUrl }, composioMcpOrigin: composio.mcpOrigin, ...(full ? {} : { apiOnly: true }) });
  /** A request with the server's API token, never the owner's session. */
  const token = (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${server.token}` });
  return { composio, log, server, token };
}

/** An inline run of `expert` granted mail's `add`, bound to USER_A's account (`account` false: to USER_A alone, so its
 *  start reads no account at Composio): its answer. */
const inlineRun = (s, expert = "mail-reader", { account = true } = {}) => s.token("POST", "/runs", {
  external: { source: "backend", kind: "expert", id: expert, version: 1 },
  definition: { name: `Expert ${expert}`, instructions: "Answer.", skills: [], tools: ["mcp:mail/add"], tool_settings: { "mcp:mail/add": { permission: "allow" } }, harness: "pi" },
  input: { content: CALL },
  mcp_auth: { mail: { composio_user_id: USER_A, ...(account ? { connected_account_id: ACCOUNT_A } : {}) } },
});
const runCount = async (s) => (await s.token("GET", "/runs")).body.runs.length;

test("API-only: the token saves a per-run Composio server by api_key_env (200); the names route lists it with no credential; the store holds the name, never the value; the delete reaches Composio with the variable's value", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t);
  const saved = await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.server?.name, "mail");
  assert.ok(s.composio.calls.length > 0 && s.composio.calls.every((call) => call.keyOk), "every call the save made to Composio carried the variable's value");

  // Its one listing: the names route (GET /settings/mcp-server-names), the saved servers' names and nothing else.
  const names = await s.token("GET", "/settings/mcp-server-names");
  assert.deepEqual([names.status, names.body], [200, { names: ["mail"] }], JSON.stringify(names.body));
  const row = await s.server.store.mcp.server("mail");
  for (const value of [KEY, "x-api-key", new URL(row.url).host, KEY_ENV]) assert.equal(JSON.stringify(names.body).includes(value), false, `the names hold no ${value}`);

  assert.equal(row.sealed, null, "the row seals no credential");
  assert.equal(new URL(row.url).searchParams.has("user_id"), false, "and its address names no user");
  const record = await s.server.store.settings.get(composioMadeKey("mail"));
  assert.equal(record.key_env, KEY_ENV, "its record names the variable");
  await s.server.store.flush();
  assert.equal(storeBytes(s.server.data).includes(Buffer.from(KEY)), false, "the store's bytes never hold the key");
  assert.equal(JSON.stringify([saved.body, names.body, record]).includes(KEY), false, "no answer or record holds the key");
  assert.equal(s.log.text().includes(KEY), false, "no log line holds the key");

  const from = s.composio.calls.length;
  const deleted = await s.token("DELETE", "/settings/mcp-servers/mail");
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.composio?.removed, true, `what the save made at Composio is removed with the variable's value: ${JSON.stringify(deleted.body)}`);
  const sent = s.composio.calls.slice(from);
  assert.ok(sent.some((call) => call.method === "DELETE") && sent.every((call) => call.keyOk), "the delete's calls carried the variable's value");
  assert.deepEqual((await s.token("GET", "/settings/mcp-server-names")).body, { names: [] }, "gone");
});

test("API-only: api_key_env naming another variable is 422 invalid naming COMPOSIO_API_KEY, and nothing is sent to Composio", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY, ANTHROPIC_API_KEY: OTHER, OTHER_KEY });
  const s = await setup(t);
  for (const [name, value] of [["OTHER_KEY", OTHER_KEY], ["ANTHROPIC_API_KEY", OTHER]]) {
    const refused = await s.token("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, api_key_env: name });
    const issue = refused.body.error?.fields?.[0];
    assert.deepEqual([refused.status, issue?.field, issue?.reason], [422, "api_key_env", "invalid"], `${name}: ${JSON.stringify(refused.body)}`);
    assert.match(issue.message, /COMPOSIO_API_KEY/, "the message names the one variable taken");
    assert.equal(JSON.stringify(refused.body).includes(value), false, "never the other variable's value");
  }
  assert.deepEqual(s.composio.calls, [], "nothing sent to Composio");
  assert.deepEqual((await s.token("GET", "/settings/mcp-server-names")).body, { names: [] }, "nothing saved");
});

test("API-only: a second project's saved key name governs save, run and delete, with no fallback to the legacy key", async (t) => {
  withEnv(t, { [KEY_ENV]: OTHER_KEY, [PROJECT_KEY_ENV]: KEY });
  const s = await setup(t);
  const caps = await s.token("GET", "/capabilities");
  assert.deepEqual(caps.body.features.mcp_client.composio_key_envs, [KEY_ENV, PROJECT_KEY_ENV]);
  const saved = await s.token("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, api_key_env: PROJECT_KEY_ENV });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(s.composio.calls.every((call) => call.keyOk), "the save used the second project's key");
  assert.equal((await s.server.store.settings.get(composioMadeKey("mail"))).key_env, PROJECT_KEY_ENV);
  assert.equal((await s.server.store.mcp.server("mail")).sealed, null);
  const original = await s.server.store.mcp.server("mail");
  const originalRecord = await s.server.store.settings.get(composioMadeKey("mail"));
  const beforeSwitch = s.composio.calls.length;
  const switched = await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE);
  assert.equal(switched.status, 422, JSON.stringify(switched.body));
  assert.deepEqual(switched.body.error.fields.map((field) => [field.field, field.reason]), [["api_key_env", "not_allowed"]]);
  assert.equal(s.composio.calls.length, beforeSwitch, "a different project under the same name reaches neither project");
  assert.deepEqual(await s.server.store.mcp.server("mail"), original);
  assert.deepEqual(await s.server.store.settings.get(composioMadeKey("mail")), originalRecord);
  const started = await inlineRun(s);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(s.server.api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const view = (await s.token("GET", `/runs/${started.body.run_id}`)).body;
  assert.match(String(view.result?.final_answer ?? ""), /The tool said: 5/, JSON.stringify(view));
  assert.deepEqual([...new Set(s.composio.mcpKeys)], [KEY], "the runner also uses the saved key name");

  delete process.env[PROJECT_KEY_ENV];
  const from = s.composio.calls.length;
  const refused = await inlineRun(s, "missing-project-key", { account: false });
  assert.ok(refused.status >= 400 && refused.status < 500, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body.error), /AGENTRUN_COMPOSIO_API_KEY/);
  assert.equal(s.composio.calls.length, from, "no attempt with the legacy key");
  process.env[PROJECT_KEY_ENV] = KEY;
  const deleted = await s.token("DELETE", "/settings/mcp-servers/mail");
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.composio?.removed, true, JSON.stringify(deleted.body));
  assert.ok(s.composio.calls.slice(from).every((call) => call.keyOk), "cleanup uses the same project");
  await s.server.store.flush();
  for (const value of [KEY, OTHER_KEY]) assert.equal(storeBytes(s.server.data).includes(Buffer.from(value)), false);
});

test("API-only: api_key_env with COMPOSIO_API_KEY unset or blank is 422 missing naming it; nothing sent", async (t) => {
  for (const env of [{}, { [KEY_ENV]: "  " }]) {
    await t.test(JSON.stringify(env), async (t) => {
      withEnv(t, env, [KEY_ENV]);
      const s = await setup(t);
      const refused = await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE);
      const issue = refused.body.error?.fields?.[0];
      assert.deepEqual([refused.status, issue?.field, issue?.reason], [422, "api_key_env", "missing"], JSON.stringify(refused.body));
      assert.match(issue.message, /COMPOSIO_API_KEY/);
      assert.deepEqual(s.composio.calls, [], "nothing sent to Composio");
    });
  }
});

test("API-only: a key's value from the token is still the one secret-write refusal (403), alone or beside api_key_env; nothing sent", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t);
  for (const body of [{ api_key: KEY, toolkit: "gmail", tools: ["add"] }, { ...SAVE, api_key: KEY }]) {
    const refused = await s.token("PUT", "/settings/mcp-servers/mail/composio", body);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.ok(String(refused.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), refused.body.error?.message);
  }
  assert.deepEqual(s.composio.calls, [], "nothing sent to Composio");
});

test("full profile: the token's api_key_env is the one secret-write refusal (403), nothing sent; its listing is as it was", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { full: true });
  const refused = await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.ok(String(refused.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), refused.body.error?.message);
  assert.deepEqual(s.composio.calls, [], "nothing sent to Composio");
  // A server the owner saved, as the token lists it: the full view, as before.
  const gateway = await startFakeMcp();
  t.after(() => gateway.close());
  const saved = await s.token("PUT", "/settings/mcp-servers/gw", { url: gateway.url, auth: { type: "per_run" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const listed = await s.token("GET", "/settings/mcp-servers");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const [server] = listed.body.servers;
  assert.equal(server.kind, undefined, "no API-only entry");
  for (const field of ["url", "source", "credential", "protocol", "server_info", "listed_at", "updated_at", "secret"]) assert.ok(Object.hasOwn(server, field), `the full view's ${field}`);
  assert.equal(typeof server.tools[0], "object", "each tool whole");
});

test("full profile: the owner's session saves a Composio server by api_key_env; its full view names the variable, and the store holds no copy", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { full: true });
  const saved = await asOwner(s.server)("PUT", "/settings/mcp-servers/mail/composio", SAVE);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(s.composio.calls.length > 0 && s.composio.calls.every((call) => call.keyOk), "the save's calls carried the variable's value");
  const view = saved.body.server;
  assert.deepEqual(view.auth, { type: "headers", headers: ["x-api-key"], api_key_env: KEY_ENV });
  assert.equal(view.credential, null, "no credential sealed");
  assert.deepEqual({ set: view.secret?.set, source: view.secret?.source }, { set: true, source: "env" });
  assert.equal((await s.server.store.mcp.server("mail")).sealed, null);
  await s.server.store.flush();
  assert.equal(storeBytes(s.server.data).includes(Buffer.from(KEY)), false, "the store's bytes never hold the key");
});

// The token deletes only a server the token saved (recorded at the save, checked at the delete): an owner's server stays
// the owner's, sealed or not, and nothing of it reaches Composio.
test("full profile: the owner's Composio server saved by api_key_env, sealing nothing, is 403 to the token's delete: nothing reaches Composio and it stays; the owner's session deletes it", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { full: true });
  const owner = asOwner(s.server);
  assert.equal((await owner("PUT", "/settings/mcp-servers/mail/composio", SAVE)).status, 200);
  assert.equal((await s.server.store.mcp.server("mail")).sealed, null, "it seals nothing");
  const from = s.composio.calls.length;
  const refused = await s.token("DELETE", "/settings/mcp-servers/mail");
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.ok(String(refused.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), refused.body.error?.message);
  assert.equal(s.composio.calls.length, from, "nothing reached Composio");
  assert.ok(await s.server.store.mcp.server("mail"), "it stays");
  const deleted = await owner("DELETE", "/settings/mcp-servers/mail");
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.composio?.removed, true, JSON.stringify(deleted.body));
});

test("full profile: the owner's Composio server saved with its key sealed is 403 to the token's delete: nothing reaches Composio and it stays", async (t) => {
  const s = await setup(t, { full: true });
  assert.equal((await asOwner(s.server)("PUT", "/settings/mcp-servers/mail/composio", { api_key: KEY, toolkit: "gmail", tools: ["add"], user_id: "per_run" })).status, 200);
  assert.notEqual((await s.server.store.mcp.server("mail")).sealed, null, "its key is sealed");
  const from = s.composio.calls.length;
  const refused = await s.token("DELETE", "/settings/mcp-servers/mail");
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.ok(String(refused.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), refused.body.error?.message);
  assert.equal(s.composio.calls.length, from, "nothing reached Composio");
  assert.ok(await s.server.store.mcp.server("mail"), "it stays");
});

// The token saves over a server only where it saved that server (the delete's rule): an owner's server stays the owner's
// under every save route the token reaches, sealed or not, and nothing it made at Composio is removed.
/** What a test compares of a row to say it is unchanged. */
const rowOf = async (store, name) => {
  const row = await store.mcp.server(name);
  return row && { url: row.url, auth: row.auth, createdAt: row.createdAt, updatedAt: row.updatedAt, sealed: row.sealed, credentialChangedAt: row.credentialChangedAt, instructions: row.instructions };
};

test("full profile: the token's ordinary save moving the owner's Composio server (api_key_env, sealing nothing) to another address is 403: nothing reaches Composio, and the row and its records are unchanged", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  // The address the token's save names: one that lists tools, so only the refusal stops the save.
  const elsewhere = await startFakeMcp();
  t.after(() => elsewhere.close());
  const s = await setup(t, { full: true });
  assert.equal((await asOwner(s.server)("PUT", "/settings/mcp-servers/mail/composio", SAVE)).status, 200);
  const store = s.server.store;
  assert.equal((await store.mcp.server("mail")).sealed, null, "it seals nothing");
  const [row, made, source] = [await rowOf(store, "mail"), await store.settings.get(composioMadeKey("mail")), await store.settings.get(mcpSourceKey("mail"))];
  const from = s.composio.calls.length;
  const moved = await s.token("PUT", "/settings/mcp-servers/mail", { url: elsewhere.url, auth: { type: "none" } });
  assert.equal(moved.status, 403, JSON.stringify(moved.body));
  assert.ok(String(moved.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), moved.body.error?.message);
  const sent = s.composio.calls.slice(from);
  assert.deepEqual(sent.filter((call) => call.method === "DELETE").map((call) => call.path), [], "no DELETE of its MCP server, account or auth config");
  assert.deepEqual(sent, [], "nothing reached Composio");
  assert.deepEqual(elsewhere.log, [], "the other address got nothing");
  assert.deepEqual(await rowOf(store, "mail"), row, "the row is unchanged");
  assert.deepEqual([await store.settings.get(composioMadeKey("mail")), await store.settings.get(mcpSourceKey("mail"))], [made, source], "its records are unchanged");
});

test("API-only: the token's Composio save over a Composio server it did not save (sealing nothing) is 403: nothing reaches Composio, and the row and its records are unchanged", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t);
  assert.equal((await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE)).status, 200);
  const store = s.server.store;
  // The owner's: its record without the token's mark, as the owner's save over it leaves it (or a save before the mark).
  await store.settings.put(mcpSourceKey("mail"), ownersRecord(await store.settings.get(mcpSourceKey("mail"))));
  const [row, made, source] = [await rowOf(store, "mail"), await store.settings.get(composioMadeKey("mail")), await store.settings.get(mcpSourceKey("mail"))];
  const from = s.composio.calls.length;
  const again = await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE);
  assert.equal(again.status, 403, JSON.stringify(again.body));
  assert.ok(String(again.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), again.body.error?.message);
  assert.deepEqual(s.composio.calls.slice(from), [], "nothing reached Composio");
  assert.deepEqual(await rowOf(store, "mail"), row, "the row is unchanged");
  assert.deepEqual([await store.settings.get(composioMadeKey("mail")), await store.settings.get(mcpSourceKey("mail"))], [made, source], "its records are unchanged");
  // The token's own is still the token's to save again.
  await store.settings.put(mcpSourceKey("mail"), { ...source, by: "token" });
  const own = await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE);
  assert.equal(own.status, 200, JSON.stringify(own.body));
});

test("API-only: the token saves no server at an address of its own: the generic save, the list and the read are refused (404), and the address gets nothing", async (t) => {
  const elsewhere = await startFakeMcp();
  t.after(() => elsewhere.close());
  const s = await setup(t);
  for (const auth of [{ type: "per_run" }, { type: "none" }, { type: "headers", headers: { "x-api-key": OTHER_KEY } }]) {
    const refused = await s.token("PUT", "/settings/mcp-servers/gw", { url: elsewhere.url, auth });
    assert.equal(refused.status, 404, `${auth.type}: ${JSON.stringify(refused.body)}`);
  }
  assert.equal((await s.token("GET", "/settings/mcp-servers")).status, 404, "no list of its own");
  assert.equal((await s.token("GET", "/settings/mcp-servers/gw")).status, 404, "no read");
  assert.deepEqual(elsewhere.log, [], "the address got nothing");
  assert.deepEqual((await s.token("GET", "/settings/mcp-server-names")).body, { names: [] }, "nothing saved");
});

test("API-only: a Composio save takes no url or headers from its body: each is 422 not_allowed, nothing is sent to Composio or the address", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const elsewhere = await startFakeMcp();
  t.after(() => elsewhere.close());
  const s = await setup(t);
  for (const [field, value] of [["url", elsewhere.url], ["headers", { authorization: `Bearer ${OTHER_KEY}` }]]) {
    const refused = await s.token("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, [field]: value });
    const issue = refused.body.error?.fields?.[0];
    assert.deepEqual([refused.status, issue?.field, issue?.reason], [422, field, "not_allowed"], `${field}: ${JSON.stringify(refused.body)}`);
  }
  assert.deepEqual(s.composio.calls, [], "nothing sent to Composio");
  assert.deepEqual(elsewhere.log, [], "nor to the body's address");
  assert.deepEqual((await s.token("GET", "/settings/mcp-server-names")).body, { names: [] }, "nothing saved");
});

/** The add tool as a saved row keeps it. */
const ADD_TOOL = { name: "add", title: "Add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, annotations: { readOnlyHint: true } };
/** A Composio record that names COMPOSIO_API_KEY as its key (composio-made.ts key_env), as the preset writes one: for a
 *  server of one Composio user, or (`perRun`) one whose runs each name theirs. */
const envRecord = (perRun) => (perRun ? { user: "per_run", auth_config: null, accounts: [], per_run: true, key_env: KEY_ENV } : { user: "agentrun", auth_config: null, accounts: [], key_env: KEY_ENV });

/** A row written by hand, not by the preset: `name` at `url` (any origin), auth headers sealing nothing, and a Composio
 *  record bound to it saying its key is COMPOSIO_API_KEY. What a store edited behind the server's back could hold. */
async function handWritten(store, name, url, { perRun = false, keyEnv = KEY_ENV } = {}) {
  await store.mcp.put({ name, url, auth: "headers", tools: [ADD_TOOL], sealed: null });
  await store.settings.put(composioMadeKey(name), storedMade({ ...envRecord(perRun), key_env: keyEnv }, await store.mcp.server(name)));
  await store.flush?.();
}

test("a row reading its key from COMPOSIO_API_KEY at an address off Composio's origin is refused by name at a save and a refresh, and at an API-only run's start; that host gets nothing", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const elsewhere = await startFakeMcp();
  t.after(() => elsewhere.close());
  const full = await setup(t, { full: true });
  await handWritten(full.server.store, "mail", elsewhere.url);
  const owner = asOwner(full.server);
  // The owner's save that keeps the credential, and a refresh: each opens the row's key for its address.
  for (const [method, path, body] of [["PUT", "/settings/mcp-servers/mail", { url: elsewhere.url, auth: { type: "headers" } }], ["POST", "/settings/mcp-servers/mail/refresh", undefined]]) {
    const refused = await owner(method, path, body);
    assert.equal(refused.status, 422, `${method} ${path}: ${JSON.stringify(refused.body)}`);
    assert.match(JSON.stringify(refused.body.error), /mail.*Composio/, `${method} ${path}: refused by name`);
    assert.equal(JSON.stringify(refused.body).includes(KEY), false);
  }
  assert.deepEqual(elsewhere.log, [], "the save and the refresh sent nothing");

  const s = await setup(t);
  await handWritten(s.server.store, "mail", elsewhere.url, { perRun: true });
  const before = await runCount(s);
  const run = await inlineRun(s);
  assert.ok(run.status >= 400 && run.status < 500, `refused before it starts: ${JSON.stringify(run.body)}`);
  assert.match(JSON.stringify(run.body.error), /mail.*Composio/, "by name");
  assert.equal(await runCount(s), before, "no run made");
  assert.deepEqual(elsewhere.log, [], "the run sent nothing");
});

for (const keyEnv of [KEY_ENV, PROJECT_KEY_ENV]) {
test(`claim: ${keyEnv} is refused off Composio's origin and sends the selected project key on origin`, async (t) => {
  withEnv(t, { [KEY_ENV]: OTHER_KEY, [PROJECT_KEY_ENV]: OTHER_KEY, [keyEnv]: KEY });
  const elsewhere = await startFakeMcp();
  t.after(() => elsewhere.close());
  const sealKey = Buffer.alloc(32, 7);
  const claimOf = async (store, runId, composioMcpOrigin) => {
    await queued(store, runId, { mcpPin: await registryPin(store) });
    const claim = await store.claim(runId, "runner-a", { leaseMs: 60_000 });
    return mcpClaim({ store, claim, grants: ["mcp:mail/add"], sealKey, signal: new AbortController().signal, loopback: true, composioMcpOrigin });
  };
  const { store } = await storeOn(t);
  await handWritten(store, "mail", elsewhere.url, { keyEnv });
  // Composio's origin (here a stand-in) is not the row's: refused, nothing sent.
  await assert.rejects(claimOf(store, "run-1", "https://composio.invalid"), (error) => {
    assert.match(error.message, /mail.*Composio/, error.message);
    assert.equal(error.message.includes(KEY), false);
    return true;
  });
  assert.deepEqual(elsewhere.log, [], "that host got nothing");
  // The same row on the origin the claim takes as Composio's: the claim hands its calls the variable's value.
  const step = await claimOf(store, "run-2", new URL(elsewhere.url).origin);
  t.after(() => step.release());
  assert.equal(step.credentials.mail?.headers?.["x-api-key"], KEY, "on Composio's origin the key is attached");
});
}

test("claim: a run granted no tool of the Composio server gets no entry for it, and nothing it is handed holds the key", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const composio = await startFakeMcp();
  t.after(() => composio.close());
  const sealKey = Buffer.alloc(32, 7);
  const { store } = await storeOn(t);
  await handWritten(store, "mail", composio.url, { perRun: true });
  for (const [runId, grants] of [["run-none", []], ["run-other", ["read", "web_fetch"]]]) {
    await queued(store, runId, { mcpPin: await registryPin(store) });
    const claim = await store.claim(runId, "runner-a", { leaseMs: 60_000 });
    const step = await mcpClaim({ store, claim, grants, sealKey, signal: new AbortController().signal, loopback: true, composioMcpOrigin: new URL(composio.url).origin });
    t.after(() => step?.release());
    assert.equal(step?.credentials?.mail, undefined, `${runId}: no entry for the Composio server`);
    assert.equal(JSON.stringify(step ?? {}).includes(KEY), false, `${runId}: nothing holds the key`);
  }
  assert.deepEqual(composio.log, [], "Composio got nothing");
});

test("API-only: a server the token did not save (a row written by hand, sealing nothing) is 403 to the token's delete, and it stays", async (t) => {
  const elsewhere = await startFakeMcp();
  t.after(() => elsewhere.close());
  const s = await setup(t);
  await s.server.store.mcp.put({ name: "gw", url: elsewhere.url, auth: "none", tools: [ADD_TOOL], sealed: null });
  const refused = await s.token("DELETE", "/settings/mcp-servers/gw");
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.ok(String(refused.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), refused.body.error?.message);
  assert.deepEqual((await s.token("GET", "/settings/mcp-server-names")).body, { names: ["gw"] }, "it stays");
});

test("API-only: a run of a Composio server whose variable was unset after its save is refused by name, and no run starts", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t);
  assert.equal((await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE)).status, 200);
  const first = await inlineRun(s);
  assert.equal(first.status, 202, JSON.stringify(first.body));
  await follow(s.server.api, first.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const before = await runCount(s);

  delete process.env[KEY_ENV];
  // A run naming an account: the start's check of it can't open the key, so it is refused by name there.
  const checked = await inlineRun(s);
  assert.equal(checked.status, 422, JSON.stringify(checked.body));
  assert.match(checked.body.error.message, /mail.*COMPOSIO_API_KEY/, checked.body.error.message);
  // One naming no account: the agent its first run made, pinned already, is refused at the run's start.
  const again = await inlineRun(s, "mail-reader", { account: false });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error?.code, "agent_not_runnable");
  assert.match(again.body.error.message, /mail.*COMPOSIO_API_KEY/, again.body.error.message);
  assert.deepEqual(again.body.error.fields?.map((issue) => [issue.field, issue.reason]), [["definition.tools[0]", "missing"]]);
  // An agent never run before: its save can't list the server to pin it, in the same words.
  const fresh = await inlineRun(s, "mail-writer", { account: false });
  assert.equal(fresh.status, 422, JSON.stringify(fresh.body));
  assert.match(JSON.stringify(fresh.body.error), /COMPOSIO_API_KEY/);
  assert.equal(await runCount(s), before, "no run made");
});

test("API-only: the server keeps the variable's name, not its value: after the value changes, a run's connection to Composio sends the new one", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t);
  assert.equal((await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE)).status, 200);
  process.env[KEY_ENV] = ROTATED;
  const from = s.composio.mcpKeys.length;
  // Bound to the user alone: the fake's API takes KEY only, and a start naming an account reads it there first.
  const started = await inlineRun(s, "mail-reader", { account: false });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await follow(s.server.api, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const view = (await s.token("GET", `/runs/${started.body.run_id}`)).body;
  assert.match(String(view.result?.final_answer ?? ""), /The tool said: 5/, `the call answered: ${JSON.stringify(view.result ?? view.error)}`);
  const sent = s.composio.mcpKeys.slice(from);
  assert.ok(sent.length > 0, "the run reached Composio's MCP endpoint");
  assert.deepEqual([...new Set(sent)], [ROTATED], "every request carried the value the variable holds now");
  await s.server.store.flush();
  for (const value of [KEY, ROTATED]) assert.equal(storeBytes(s.server.data).includes(Buffer.from(value)), false, "the store holds neither value");
});

test("Composio's origin is one constant, and its seam is a test's alone: no environment variable, flag or setting maps onto composioMcpOrigin", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const src = new URL("../src/", import.meta.url).pathname;
  const files = (await readdir(src, { recursive: true })).filter((f) => f.endsWith(".ts"));
  const text = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await readFile(src + f, "utf8")])));
  // The one place a key read from the environment may go, and the preset's API base: the same constant.
  assert.match(text["composio-made.ts"], /export const COMPOSIO_ORIGIN = "https:\/\/backend\.composio\.dev";/);
  assert.deepEqual(files.filter((f) => /["'`]https:\/\/backend\.composio\.dev/.test(text[f])), ["composio-made.ts"], "no second literal of it");
  // The seam: the server's option and the runner's deps, carried to the claim step and a run's own process.
  const seam = files.filter((f) => /\bcomposioMcpOrigin\b/.test(text[f])).sort();
  assert.deepEqual(seam, ["runner/adapter-run-spec.ts", "runner/cli-run-spec.ts", "runner/mcp-claim.ts", "runner/mcp-run.ts", "runner/run-child-deps.ts", "runner/run-child-host.ts", "server.ts"]);
  for (const f of ["cli.ts", "runner/main.ts"]) assert.ok(!/composioMcpOrigin|composioOrigin|COMPOSIO_ORIGIN/.test(text[f]), `${f} maps nothing onto it`);
  const lines = Object.entries(text).flatMap(([f, body]) => body.split("\n").map((line) => [f, line]));
  assert.deepEqual(lines.filter(([, line]) => /composioMcpOrigin|composioOrigin/.test(line) && /process\.env|\benv\[|\bargv\b|--[a-z]/.test(line)), [], "no environment variable or flag names it");
  assert.deepEqual(lines.filter(([, line]) => /dispatchRunner\(/.test(line) && /composioMcpOrigin/.test(line)), [], "no runner the server or the CLI starts sets it");
  const testDir = new URL("./", import.meta.url).pathname;
  const tests = (await readdir(testDir, { recursive: true })).filter((f) => /\.(mjs|js|ts)$/.test(f));
  const setters = [];
  for (const f of tests) for (const line of (await readFile(testDir + f, "utf8")).split("\n")) if (/\.\.\.\(composioMcpOrigin \? \{ composioMcpOrigin \} : \{\}\)/.test(line)) setters.push(f);
  assert.deepEqual(setters, ["support.mjs"], "its one setter on a runner: the test's startInProcessRunner");
});

test("API-only: the token's Composio save over an auth config a server the owner saved stands on is 403, named or found: the owner's record is unchanged and nothing of it is removed at Composio; one a server the token saved made is used, and stays that server's", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t);
  const store = s.server.store;
  assert.equal((await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE)).status, 200);
  // The owner's: its record without the token's mark (a server saved before this server was API-only, say).
  const tokens = await store.settings.get(mcpSourceKey("mail"));
  await store.settings.put(mcpSourceKey("mail"), ownersRecord(tokens));
  const owners = await store.settings.get(composioMadeKey("mail"));
  const config = owners.auth_config;
  assert.equal(config?.made, true, "the owner's server made its auth config here");
  // Named: refused in the save's own words, naming the owner's server, before anything is sent.
  let from = s.composio.calls.length;
  const named = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, user_id: "agentrun", auth_config_id: config.id });
  assert.equal(named.status, 403, JSON.stringify(named.body));
  assert.match(named.body.error?.message, new RegExp(`auth config ${config.id}.*owner's MCP server mail`), named.body.error?.message);
  assert.deepEqual(s.composio.calls.slice(from), [], "nothing reached Composio");
  // Found: the toolkit's managed auth config Composio answers is the one the owner's server stands on, so the save is
  // refused once that is known, in the same words, before anything is made at Composio; nothing of the owner's is removed.
  from = s.composio.calls.length;
  const found = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, user_id: "agentrun" });
  assert.equal(found.status, 403, JSON.stringify(found.body));
  assert.match(found.body.error?.message, new RegExp(`auth config ${config.id}.*owner`), found.body.error?.message);
  const sent = s.composio.calls.slice(from);
  assert.deepEqual(sent.filter((call) => call.method === "DELETE" && call.path.includes(config.id)), [], "the owner's auth config is not removed");
  assert.deepEqual(sent.filter((call) => call.method !== "GET"), [], "nothing made or removed at Composio");
  for (const refused of [named, found]) assert.equal(JSON.stringify(refused.body).includes(KEY), false, "the key is not echoed");
  assert.equal(await store.mcp.server("notes"), undefined, "no server saved");
  assert.deepEqual([await store.settings.get(composioMadeKey("mail")), await store.settings.get(mcpSourceKey("mail"))], [owners, ownersRecord(tokens)], "the owner's records are unchanged");
  // The token's own: an auth config a server the token saved made is the token's to use, and stays that server's.
  await store.settings.put(mcpSourceKey("mail"), tokens);
  const own = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, auth_config_id: config.id });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.deepEqual(await store.settings.get(composioMadeKey("mail")), owners, "the other server's record is unchanged: it still made the auth config");
  assert.deepEqual((await store.settings.get(composioMadeKey("notes"))).auth_config, { id: config.id, made: false }, "the token's second server uses it, and made none");
});

// An ACTIVE connected account at Composio that no record here names, under the toolkit's managed auth config and the
// Composio user `user` (the fake lists it for that user alone), whatever stands, or doesn't, beside it in the store. The
// token's save for the user_id agentrun is Composio's TOKENS_USER: an account under it is one the token's save would
// stand on; one under the bare agentrun (the owner's) is another user's, never listed for the token's.
const OWNERS_CONFIG = "ac_owners_managed";
const UNRECORDED = "ca_unrecorded_gmail";
const TOKENS_USER = "agentrun.token.agentrun";
const accountUnder = (user) => ({ authConfigs: { gmail: [{ id: OWNERS_CONFIG, is_composio_managed: true, status: "ENABLED" }] }, accounts: { gmail: [{ status: "ACTIVE", auth_config: OWNERS_CONFIG, id: UNRECORDED, user }] } });
const ACCOUNT_SHAPES = [
  // The owner's Composio server saved by hand through the generic save: a row at a Composio MCP address, no record.
  ["the owner's server saved by hand at its Composio address (no record)", async (s) => {
    await s.server.store.mcp.put({ name: "owners-mail", url: `${s.composio.mcpOrigin}/v3/mcp/srv_owners/mcp?user_id=agentrun`, auth: "none", tools: [ADD_TOOL], sealed: null });
  }],
  // Connected in Composio's dashboard: no row here at all. (An account the owner kept after deleting its server reads the
  // same here: the delete removed the row and its records, and Composio still has the account.)
  ["an account connected in Composio's dashboard (no row at all)", async () => {}],
  // A preset save from before its made-record: the owner's row recorded as a Composio server of the toolkit, no made-record.
  ["the owner's preset server saved before its made-record (source record alone)", async (s) => {
    const { storedSource } = await import("../dist/mcp-sources.js");
    await s.server.store.mcp.put({ name: "owners-mail", url: `${s.composio.mcpOrigin}/v3/mcp/srv_owners/mcp?user_id=agentrun`, auth: "none", tools: [ADD_TOOL], sealed: null });
    const row = await s.server.store.mcp.server("owners-mail");
    await s.server.store.settings.put(mcpSourceKey("owners-mail"), storedSource({ source: "composio", toolkit: "gmail" }, row, false, false));
  }],
];
for (const [shape, arrange] of ACCOUNT_SHAPES) {
  test(`API-only: the token's Composio save for a user with an ACTIVE account it did not connect is 403, nothing made at Composio: ${shape}`, async (t) => {
    withEnv(t, { [KEY_ENV]: KEY });
    const s = await setup(t, { fake: accountUnder(TOKENS_USER) });
    await arrange(s);
    const from = s.composio.calls.length;
    const res = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, user_id: "agentrun" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.error?.message, /user_id agentrun already has a connected account here that no server the API token saved holds as one it connected.*Name a user_id of the token's own/, res.body.error?.message);
    assert.deepEqual(s.composio.calls.slice(from).filter((call) => call.method !== "GET"), [], "nothing made or removed at Composio");
    assert.deepEqual(s.composio.mcpIds, [], "no MCP server made");
    assert.equal(await s.server.store.mcp.server("notes"), undefined, "no server saved");
    assert.equal(await s.server.store.settings.get(composioMadeKey("notes")), undefined, "no record of one");
    assert.equal(JSON.stringify(res.body).includes(KEY), false, "the key is not echoed");
  });

  test(`API-only: the same ACTIVE account under the bare user agentrun stays that user's: the token's save for agentrun looks up ${TOKENS_USER} alone, finds none, and saves with a connect link that never stands on it: ${shape}`, async (t) => {
    withEnv(t, { [KEY_ENV]: KEY });
    const s = await setup(t, { fake: accountUnder("agentrun") });
    await arrange(s);
    const from = s.composio.calls.length;
    const res = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, user_id: "agentrun" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(typeof res.body.connect_url, "string", "no ACTIVE account for the token's user: a connect link");
    const lookups = s.composio.calls.slice(from).filter((call) => call.method === "GET" && call.path === "/api/v3/connected_accounts");
    assert.deepEqual([...new Set(lookups.map((call) => call.query?.user_ids))], [TOKENS_USER], "the lookup names the token's user alone");
    const record = await s.server.store.settings.get(composioMadeKey("notes"));
    assert.equal(record.user, TOKENS_USER, "the record stands on the token's user");
    assert.equal(record.accounts.some((account) => account.id === UNRECORDED), false, "the record never holds the bare user's account");
    assert.deepEqual(s.composio.calls.slice(from).filter((call) => call.path.includes(UNRECORDED)), [], "nothing at Composio touches it");
  });
}

/** The Composio users the calls name: the account lookup's `user_ids`, generate's `user_ids`, the connect link's `user_id`. */
const usersSent = (calls) => calls.flatMap((call) => [call.query?.user_ids, call.body?.user_id, ...(Array.isArray(call.body?.user_ids) ? call.body.user_ids : [])]).filter((user) => user !== undefined);

for (const [given, as] of [["ops", "agentrun.token.ops"], [undefined, "agentrun.token.agentrun"]]) {
  test(`API-only: the token's Composio save ${given ? `naming the user_id ${given}` : "naming no user_id"} reaches Composio as ${as}, never as the bare user, and its server and record are ${as}'s`, async (t) => {
    withEnv(t, { [KEY_ENV]: KEY });
    const s = await setup(t);
    const saved = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, user_id: given });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    // The account lookup, generate and the connect link, each as the token's namespaced user; no call names the bare one.
    assert.deepEqual(usersSent(s.composio.calls), [as, as, as], "the user each call names");
    assert.equal(new URL((await s.server.store.mcp.server("notes")).url).searchParams.get("user_id"), as, "the saved address calls as it");
    assert.equal((await s.server.store.settings.get(composioMadeKey("notes"))).user, as, "the record stands on it");
  });
}

test("the owner's Composio save naming a user_id in the API token's namespace (agentrun.token.) is 422 under user_id, nothing sent to Composio", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { full: true });
  const res = await asOwner(s.server)("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, user_id: "agentrun.token.x" });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.deepEqual(res.body.error?.fields?.map((issue) => [issue.field, issue.reason]), [["user_id", "not_allowed"]], JSON.stringify(res.body));
  assert.deepEqual(s.composio.calls, [], "nothing sent to Composio");
  assert.equal(await s.server.store.mcp.server("mail"), undefined, "no server saved");
});

test("API-only: the token's Composio save checks every ACTIVE account Composio lists for its user under the auth config, not the first: its own (made here) then one no record names is 403, nothing made", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const accounts = {};
  const s = await setup(t, { fake: { accounts } });
  assert.equal((await s.token("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, user_id: "agentrun" })).status, 200);
  const mine = await s.server.store.settings.get(composioMadeKey("mail"));
  const [{ id: linked }] = mine.accounts;
  // The token's own account finished its link, and another ACTIVE account came up for the same user and config after it.
  accounts.gmail = [{ status: "ACTIVE", auth_config: mine.auth_config.id, id: linked, user: TOKENS_USER }, { status: "ACTIVE", auth_config: mine.auth_config.id, id: "ca_unrecorded_0001", user: TOKENS_USER }];
  const from = s.composio.calls.length;
  const res = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, user_id: "agentrun" });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.match(res.body.error?.message, /user_id agentrun already has a connected account here.*Name a user_id of the token's own/, res.body.error?.message);
  assert.deepEqual(s.composio.calls.slice(from).filter((call) => call.method !== "GET"), [], "nothing made or removed at Composio");
  assert.equal(await s.server.store.mcp.server("notes"), undefined, "no server saved");
  assert.deepEqual(await s.server.store.settings.get(composioMadeKey("mail")), mine, "the first server's record is unchanged");
});

/** A Composio whose ACTIVE connected accounts for the user under the toolkit's auth config run past the lookup's 10
 *  pages: 11 of them, one a page. */
const MANY = "ac_gmail_many";
const MANY_CONFIG = { gmail: [{ id: MANY, is_composio_managed: true, status: "ENABLED" }] };
const PAST_THE_BOUND = { authConfigs: MANY_CONFIG, accountsPage: 1, accounts: { gmail: Array.from({ length: 11 }, (_, i) => ({ status: "ACTIVE", auth_config: MANY, id: `ca_active_${String(i).padStart(2, "0")}` })) } };
/** The same user's accounts, 11 pages of them, none ACTIVE: started, expired or turned off. */
const NONE_ACTIVE = { authConfigs: MANY_CONFIG, accountsPage: 1, accounts: { gmail: Array.from({ length: 11 }, (_, i) => ({ status: ["INITIATED", "EXPIRED", "INACTIVE"][i % 3], auth_config: MANY, id: `ca_not_active_${String(i).padStart(2, "0")}` })) } };
const accountLookups = (calls) => calls.filter((call) => call.method === "GET" && call.path === "/api/v3/connected_accounts");
const accountPages = (calls) => accountLookups(calls).length;

test("API-only: the token's Composio save whose user's ACTIVE connected accounts run past the lookup's page bound is 403, since it can't check each one is its own: nothing made at Composio, no server saved", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { fake: PAST_THE_BOUND });
  const res = await s.token("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, user_id: "ops" });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.match(res.body.error?.message, /more than 10 pages of connected accounts for the user_id ops under the auth config ac_gmail_many.*can't check/, res.body.error?.message);
  assert.equal(accountPages(s.composio.calls), 10, "it read 10 pages, no more");
  assert.deepEqual([...new Set(accountLookups(s.composio.calls).map((call) => call.query?.limit))], ["50"], "each page asks for 50 accounts");
  assert.deepEqual(s.composio.calls.filter((call) => call.method !== "GET"), [], "nothing made at Composio");
  assert.equal(await s.server.store.mcp.server("mail"), undefined, "no server saved");
});

test("full profile: the owner's Composio save whose user's ACTIVE connected accounts run past the lookup's page bound is not refused: it goes on with the 10 pages it read and stands on the first ACTIVE one", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { full: true, fake: PAST_THE_BOUND });
  const res = await asOwner(s.server)("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, user_id: "ops" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(accountPages(s.composio.calls), 10, "it read 10 pages, no more");
  assert.equal(res.body.connect_url, undefined, "an ACTIVE account in what it read: no connect link");
  assert.match(JSON.stringify(await s.server.store.settings.get(composioMadeKey("mail"))), /ca_active_00/, "it stands on the first ACTIVE account");
  assert.equal(new URL((await s.server.store.mcp.server("mail")).url).searchParams.get("user_id"), "ops", "saved as the owner's user");
});

// Only an ACTIVE account can serve a save, so the lookup asks Composio for ACTIVE ones alone: a user's started, expired
// or turned-off accounts never count toward the page bound, and never cost the token's save its 403-free path.
test("API-only: the token's Composio save asks Composio for ACTIVE accounts alone, so 11 pages of the user's accounts that are not ACTIVE are one empty page: 200 with a connect link", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { fake: NONE_ACTIVE });
  const res = await s.token("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, user_id: "ops" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(typeof res.body.connect_url, "string", "no ACTIVE account: a connect link");
  assert.deepEqual(accountLookups(s.composio.calls).map((call) => call.query?.statuses), ["ACTIVE"], "one lookup, for ACTIVE accounts");
});

test("full profile: the owner's Composio save asks Composio for ACTIVE accounts alone too: one page, a connect link", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { full: true, fake: NONE_ACTIVE });
  const res = await asOwner(s.server)("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, user_id: "ops" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(typeof res.body.connect_url, "string", "no ACTIVE account: a connect link");
  assert.deepEqual(accountLookups(s.composio.calls).map((call) => call.query?.statuses), ["ACTIVE"], "one lookup, for ACTIVE accounts");
});

test("API-only: the token's re-save of a server saved before its user was namespaced (its record on the bare user) deletes at Composio the account that server's link made, which no other server stands on, and records the new user's", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t);
  assert.equal((await s.token("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, user_id: "agentrun" })).status, 200);
  // What a 0.1.0-beta.56 token save wrote: the same record, on the bare user.
  const record = await s.server.store.settings.get(composioMadeKey("mail"));
  const [{ id: old, made }] = record.accounts;
  assert.equal(made, true, "its link made the account");
  await s.server.store.settings.put(composioMadeKey("mail"), { ...record, user: "agentrun" });
  const from = s.composio.calls.length;
  const again = await s.token("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, user_id: "agentrun" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(s.composio.calls.slice(from).filter((call) => call.method === "DELETE" && call.path === `/api/v3/connected_accounts/${old}`).length, 1, "the bare user's account is deleted at Composio");
  assert.equal((await s.server.store.settings.get(composioMadeKey("mail"))).accounts.some((account) => account.id === old), false, "the new record doesn't hold it");
});

test("API-only: an account the token's own earlier save connected (its record holds the id) still backs the token's second save for that user (200), found with no connect link, and the first server's record is unchanged", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const accounts = {};
  const s = await setup(t, { fake: { accounts } });
  const first = await s.token("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, user_id: "agentrun" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const mine = await s.server.store.settings.get(composioMadeKey("mail"));
  assert.equal(mine.accounts.length, 1, JSON.stringify(mine));
  const [{ id: linked }] = mine.accounts;
  // The person finished the connect link: the account it started is ACTIVE under the auth config the first save made.
  accounts.gmail = [{ status: "ACTIVE", auth_config: mine.auth_config.id, id: linked, user: TOKENS_USER }];
  const second = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, user_id: "agentrun" });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.connect_url, undefined, "no connect link: the account is ACTIVE");
  // Found, and still marked made here, as the first server's record says (composio-made.ts madeToWrite): a delete hands it on.
  assert.deepEqual((await s.server.store.settings.get(composioMadeKey("notes"))).accounts, [{ id: linked, made: true }], "the first save's account, found");
  assert.deepEqual(await s.server.store.settings.get(composioMadeKey("mail")), mine, "the first server's record is unchanged");
});

/** A server `mail` the token saved, as a save before the account rule wrote it: the token's row calling as `user`, its
 *  source marked the token's, and the ACTIVE account UNRECORDED recorded as found (made: false), not connected here. */
async function foundByOldSave(s, user) {
  const { storedSource } = await import("../dist/mcp-sources.js");
  await s.server.store.mcp.put({ name: "mail", url: `${s.composio.mcpOrigin}/v3/mcp/srv_tokens/mcp?user_id=${user}`, auth: "headers", tools: [ADD_TOOL], sealed: null });
  const row = await s.server.store.mcp.server("mail");
  await s.server.store.settings.put(mcpSourceKey("mail"), storedSource({ source: "composio", toolkit: "gmail" }, row, false, true));
  const old = storedMade({ user, auth_config: { id: OWNERS_CONFIG, made: false }, accounts: [{ id: UNRECORDED, made: false }], key_env: KEY_ENV }, row);
  await s.server.store.settings.put(composioMadeKey("mail"), old);
  return old;
}

test("API-only: a server the token saved before its user was namespaced, whose record holds the bare user's ACTIVE account as found (made: false): that account stays the bare user's, and the token's next save for agentrun looks up its own user alone, finds none and saves with a connect link that never stands on it", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { fake: accountUnder("agentrun") });
  const old = await foundByOldSave(s, "agentrun");
  const from = s.composio.calls.length;
  const res = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, user_id: "agentrun" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(typeof res.body.connect_url, "string", "no ACTIVE account for the token's user: a connect link");
  const lookups = s.composio.calls.slice(from).filter((call) => call.method === "GET" && call.path === "/api/v3/connected_accounts");
  assert.deepEqual([...new Set(lookups.map((call) => call.query?.user_ids))], [TOKENS_USER], "the lookup names the token's user alone");
  const record = await s.server.store.settings.get(composioMadeKey("notes"));
  assert.equal(record.user, TOKENS_USER, "the record stands on the token's user");
  assert.equal(record.accounts.some((account) => account.id === UNRECORDED), false, "the record never holds the bare user's account");
  assert.deepEqual(s.composio.calls.slice(from).filter((call) => call.path.includes(UNRECORDED)), [], "nothing at Composio touches it");
  assert.deepEqual(await s.server.store.settings.get(composioMadeKey("mail")), old, "the old record is unchanged");
});

test("API-only: a server the token saved whose record holds an ACTIVE account under the token's own namespaced user as found (made: false), not connected here, never backs the token's next save for that user: 403, nothing made at Composio", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { fake: accountUnder(TOKENS_USER) });
  const old = await foundByOldSave(s, TOKENS_USER);
  const from = s.composio.calls.length;
  const res = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, user_id: "agentrun" });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.match(res.body.error?.message, /user_id agentrun already has a connected account here.*Name a user_id of the token's own/, res.body.error?.message);
  assert.deepEqual(s.composio.calls.slice(from).filter((call) => call.method !== "GET"), [], "nothing made or removed at Composio");
  assert.deepEqual(s.composio.mcpIds, [], "no MCP server made");
  assert.equal(await s.server.store.mcp.server("notes"), undefined, "no server saved");
  assert.equal(await s.server.store.settings.get(composioMadeKey("notes")), undefined, "no record of one");
  assert.deepEqual(await s.server.store.settings.get(composioMadeKey("mail")), old, "the old record is unchanged");
});

test("API-only: an auth_config_id the owner's server stands on, named in another letter case, is never taken for another: Composio's answer for it is compared with the name sent, and a mismatch is 422 under auth_config_id with nothing made", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { fake: { authConfigs: { gmail: [{ id: "ac_OwnersApp1", is_composio_managed: false, status: "ENABLED" }] }, anyCase: true } });
  const store = s.server.store;
  assert.equal((await s.token("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, auth_config_id: "ac_OwnersApp1" })).status, 200);
  await store.settings.put(mcpSourceKey("mail"), ownersRecord(await store.settings.get(mcpSourceKey("mail"))));
  const from = s.composio.calls.length;
  const variant = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, auth_config_id: "ac_ownersapp1" });
  assert.equal(variant.status, 422, JSON.stringify(variant.body));
  assert.deepEqual(variant.body.error?.fields?.map((issue) => [issue.field, issue.reason]), [["auth_config_id", "not_found"]], JSON.stringify(variant.body));
  assert.match(variant.body.error.fields[0].message, /ac_OwnersApp1/, "it names the id Composio answered");
  assert.deepEqual(s.composio.calls.slice(from).filter((call) => call.method !== "GET"), [], "nothing made at Composio");
  assert.equal(await store.mcp.server("notes"), undefined, "no server saved");
  // The exact id is the owner's server's: 403, as ever.
  const exact = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, auth_config_id: "ac_OwnersApp1" });
  assert.equal(exact.status, 403, JSON.stringify(exact.body));
});

/** A registry over a fresh store, as an API-only server holds it (its origins `origins`, held in the store as the server's
 *  start holds them), and its store's clock. */
async function registryOn(t, origins) {
  const { McpServersOverStore } = await import("../dist/mcp-servers-store.js");
  const { holdApiOnlyMcpOrigins } = await import("../dist/mcp-api-only-origins.js");
  // The store's clock, a test's own to move: a row written later is created later.
  const clock = { now: Date.UTC(2026, 10, 23) };
  const { store } = await storeOn(t, { clock });
  const seal = Buffer.alloc(32, 9);
  const registry = new McpServersOverStore(store, { AGENTRUN_SEAL_KEY: seal.toString("base64").replace(/=+$/, "") }, "test");
  registry.attach("http://127.0.0.1:1", "http://127.0.0.1:1", true);
  await holdApiOnlyMcpOrigins(store, true, origins);
  return { store, seal, registry, clock };
}

test("store: the API-only token's save that read a row the token did not save is 412 by its own check, even once the token's own row stands under the name with the credential the gate read: the row and its record stay the token's", async (t) => {
  const listed = await startFakeMcp();
  t.after(() => listed.close());
  const elsewhere = await startFakeMcp();
  t.after(() => elsewhere.close());
  const { saveMcpServer } = await import("../dist/mcp-store.js");
  const { storedSource } = await import("../dist/mcp-sources.js");
  const { credentialMark } = await import("../dist/mcp-secret-writes.js");
  const { store, seal, registry, clock } = await registryOn(t, [new URL(listed.url).origin]);
  // The row the save reads first: one written by hand (no record), per_run, none sealed.
  const hand = await saveMcpServer(store, seal, { name: "gw", url: elsewhere.url, auth: "per_run", tools: [] });
  // Right after that read, the name is the token's own row, at a listed origin, with the same credential (per_run, none
  // sealed). The store's statement compares the credential and the token's mark on the row it writes, and both hold, so
  // it would let the write through: the save's own check of the row it read is all that refuses it.
  const real = store.mcp.server;
  let mine;
  store.mcp.server = async (...args) => {
    store.mcp.server = real;
    const read = await real.apply(store.mcp, args);
    await store.mcp.remove("gw");
    clock.now += 1_000;
    mine = await saveMcpServer(store, seal, { name: "gw", url: listed.url, auth: "per_run", tools: [] });
    await store.settings.put(mcpSourceKey("gw"), storedSource({ source: "url", toolkit: "notes" }, mine, false, true));
    return read;
  };
  await assert.rejects(registry.save("gw", { url: listed.url, auth: { type: "per_run" } }, undefined, credentialMark(hand), undefined, undefined, undefined, undefined, true), (error) => {
    assert.equal(error.code, "precondition_failed", error.message);
    return true;
  });
  assert.ok(mine && mine.createdAt !== hand.createdAt, "the token's row took the name between");
  assert.deepEqual(credentialMark(mine), credentialMark(hand), "with the credential the gate read");
  const record = await store.settings.get(mcpSourceKey("gw"));
  assert.deepEqual([record?.by, record?.toolkit, record?.of], ["token", "notes", mine.createdAt], "the record stays the token's, as it was written");
});
