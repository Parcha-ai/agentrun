// MCP servers on an API-only server (AGENTRUN_API_ONLY=1), which has no owner: its token saves a Composio server through
// the preset and deletes a server, and never writes a secret; the saved servers' names are its one listing
// (GET /settings/mcp-server-names). A Composio save names its key by the server's own environment variable
// (`api_key_env: "COMPOSIO_API_KEY"`, the one name taken): the server keeps that name, never the value, and reads the value
// at each use (the save's own calls to Composio, a run's connection, the delete's), and only ever sends it to Composio's
// origin, whatever a stored row says. Its generic save takes a per_run server alone, at an origin the operator listed in
// AGENTRUN_MCP_TOKEN_ORIGINS (exactly: https, or the one loopback origin with its port under AGENTRUN_MCP_ALLOW_LOOPBACK),
// keeping no credential and recording its toolkit, over no row but its own; each run's start and claim of a server it saved
// check that origin again. The list and
// the read stay refused there. The full profile is as before: its token's `api_key_env` is the one secret-write refusal.
// Fake Composio on loopback (fixtures/fake-composio.mjs, its MCP origin the composioMcpOrigin seam), fake MCP servers on
// loopback (one behind TLS with a certificate this process trusts), the faux MCP model (fixtures/faux-mcp.mjs). No key,
// no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { queued, registryPin, storeOn } from "./store-helpers.mjs";
import { answerFlow, asOwner, follow, scratch, serve, serverLog, storeBytes, withEnv } from "./support.mjs";

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
const USER_A = "user-alice-0001";
const ACCOUNT_A = "ca_alice_gmail_0001";
const MCP_ACCOUNTS = { [USER_A]: [ACCOUNT_A] };
const CALL = 'Call mcp__mail__add with {"a":2,"b":3}';
const SAVE = { api_key_env: KEY_ENV, toolkit: "gmail", tools: ["add"], user_id: "per_run" };

/** A server (API-only unless `full`) beside a fake Composio whose key is KEY (`fake`: more of its options), and the log. */
async function setup(t, { full = false, fake = {} } = {}) {
  const composio = await startFakeComposio({ apiKey: KEY, toolkits: TOOLKITS, mcpAccounts: MCP_ACCOUNTS, ...fake });
  t.after(() => composio.close());
  const log = serverLog(t);
  // The fake's MCP endpoint stands in for Composio's origin (composioMcpOrigin, the server's and runner's test-only seam).
  const server = await serve(t, { faux: FAUX_MCP, composioControl: { baseUrl: composio.baseUrl }, composioMcpOrigin: composio.mcpOrigin, ...(full ? {} : { apiOnly: true }) });
  /** A request with the server's API token, never the owner's session. */
  const token = (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${server.token}` });
  return { composio, log, server, token };
}

/** An inline run of `expert` granted mail's `add`, bound to USER_A's account: its answer. */
const inlineRun = (s, expert = "mail-reader") => s.token("POST", "/runs", {
  external: { source: "backend", kind: "expert", id: expert, version: 1 },
  definition: { name: `Expert ${expert}`, instructions: "Answer.", skills: [], tools: ["mcp:mail/add"], tool_settings: { "mcp:mail/add": { permission: "allow" } }, harness: "pi" },
  input: { content: CALL },
  mcp_auth: { mail: { composio_user_id: USER_A, connected_account_id: ACCOUNT_A } },
});
const runCount = async (s) => (await s.token("GET", "/runs")).body.runs.length;

test("API-only: the token saves a per-run Composio server by api_key_env (200); the names route lists it with no credential; the store holds the name, never the value; the delete reaches Composio with the variable's value", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t);
  const saved = await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.server?.name, "mail");
  assert.ok(s.composio.calls.length > 0 && s.composio.calls.every((call) => call.keyOk), "every call the save made to Composio carried the variable's value");
  // Its answer carries no credential and no query: the address shown is its origin alone (shownUrl), never its user.
  assert.equal(saved.body.server.credential, null, "no credential in the answer");
  assert.match(saved.body.server.url, /^https?:\/\/[^/?#]+\/…?$/, `the address shown: ${saved.body.server.url}`);
  for (const value of [KEY, "?", "user_id"]) assert.equal(JSON.stringify(saved.body).includes(value), false, `the answer holds no ${value}`);

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

const ORIGINS_ENV = "AGENTRUN_MCP_TOKEN_ORIGINS";
/** A server's origin, as listed in AGENTRUN_MCP_TOKEN_ORIGINS. */
const originOf = (url) => new URL(url).origin;
/** A refusal's first issue as [status, field, reason]. */
const issueOf = (answer) => [answer.status, answer.body.error?.fields?.[0]?.field, answer.body.error?.fields?.[0]?.reason];

/** A self-signed certificate for 127.0.0.1, made with openssl in a folder of this test's (removed after it). */
function certificate(t) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-tls-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
}

/** The fake MCP server behind TLS on loopback (this process trusting its certificate until the test ends): its https URL. */
async function overTls(t, fake) {
  const { key, cert } = certificate(t);
  const trusted = tls.getCACertificates("default");
  tls.setDefaultCACertificates([...trusted, cert]);
  t.after(() => tls.setDefaultCACertificates(trusted));
  const port = Number(new URL(fake.url).port);
  const front = tls.createServer({ key, cert }, (socket) => {
    const back = connect(port, "127.0.0.1");
    socket.on("error", () => back.destroy());
    back.on("error", () => socket.destroy());
    socket.pipe(back).pipe(socket);
  });
  await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => front.close(resolve)));
  const url = new URL(fake.url);
  url.protocol = "https:";
  url.port = String(front.address().port);
  return url.href;
}

/** A fake MCP server, closed when the test ends, serving the notes tools a package's `url notes` need grants. */
async function notesFake(t) {
  const fake = await startFakeMcp({ name: "notes" });
  t.after(() => fake.close());
  for (const name of ["list_notes", "send_note"]) fake.tools[name] = { description: `The ${name} tool.`, input: { type: "object", properties: { to: { type: "string" } }, additionalProperties: true }, run: () => ({ content: [{ type: "text", text: "[]" }] }) };
  return fake;
}

/** A templates folder with one package whose MCP need is `url notes` (not required). */
async function notesTemplates(t) {
  const root = join(await scratch(t), "templates");
  mkdirSync(join(root, "notes-digest"), { recursive: true });
  writeFileSync(join(root, "notes-digest", "agent.md"), `---
name: notes-digest
version: 1.0.0
description: Reads your notes.
mcp:
  - source: url
    toolkit: notes
    tools: [list_notes]
    required: false
    reason: "Reads your notes."
---
Call mcp:notes/list_notes.
`);
  return root;
}

/** An API-only server with no runner (its options `options`) and its token's requests. */
async function tokenServer(t, options = {}) {
  const server = await serve(t, { apiOnly: true, runner: false, ...options });
  return { server, token: (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${server.token}` }) };
}

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

// An ACTIVE connected account at Composio that no record here names: the toolkit's managed auth config already holds the
// default user's account (the fake's `active`), whatever stands, or doesn't, beside it in the store.
const OWNERS_CONFIG = "ac_owners_managed";
const OWNERS_ACCOUNT = { authConfigs: { gmail: [{ id: OWNERS_CONFIG, is_composio_managed: true, status: "ENABLED" }] }, active: ["gmail"] };
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
    const s = await setup(t, { fake: OWNERS_ACCOUNT });
    await arrange(s);
    const from = s.composio.calls.length;
    const res = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, user_id: "agentrun" });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.error?.message, /user_id agentrun already has a connected account here.*Name a user_id of the token's own/, res.body.error?.message);
    assert.deepEqual(s.composio.calls.slice(from).filter((call) => call.method !== "GET"), [], "nothing made or removed at Composio");
    assert.deepEqual(s.composio.mcpIds, [], "no MCP server made");
    assert.equal(await s.server.store.mcp.server("notes"), undefined, "no server saved");
    assert.equal(await s.server.store.settings.get(composioMadeKey("notes")), undefined, "no record of one");
    assert.equal(JSON.stringify(res.body).includes(KEY), false, "the key is not echoed");
  });
}

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
  accounts.gmail = [{ status: "ACTIVE", auth_config: mine.auth_config.id, id: linked }];
  const second = await s.token("PUT", "/settings/mcp-servers/notes/composio", { ...SAVE, user_id: "agentrun" });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.connect_url, undefined, "no connect link: the account is ACTIVE");
  // Found, and still marked made here, as the first server's record says (composio-made.ts madeToWrite): a delete hands it on.
  assert.deepEqual((await s.server.store.settings.get(composioMadeKey("notes"))).accounts, [{ id: linked, made: true }], "the first save's account, found");
  assert.deepEqual(await s.server.store.settings.get(composioMadeKey("mail")), mine, "the first server's record is unchanged");
});

test("API-only: a server the token saved before the account rule, whose record holds the owner's ACTIVE account as found (made: false), never backs the token's next save for that user: 403, nothing made at Composio", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { fake: OWNERS_ACCOUNT });
  const { storedSource } = await import("../dist/mcp-sources.js");
  // What such a save wrote: the token's row, its source marked the token's, and the owner's account recorded as found.
  await s.server.store.mcp.put({ name: "mail", url: `${s.composio.mcpOrigin}/v3/mcp/srv_tokens/mcp?user_id=agentrun`, auth: "headers", tools: [ADD_TOOL], sealed: null });
  const row = await s.server.store.mcp.server("mail");
  await s.server.store.settings.put(mcpSourceKey("mail"), storedSource({ source: "composio", toolkit: "gmail" }, row, false, true));
  const old = storedMade({ user: "agentrun", auth_config: { id: OWNERS_CONFIG, made: false }, accounts: [{ id: "ca_fake_gmail", made: false }], key_env: KEY_ENV }, row);
  await s.server.store.settings.put(composioMadeKey("mail"), old);
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

test("API-only, AGENTRUN_MCP_TOKEN_ORIGINS unset: the token's per_run save is 422 url not_an_option naming the variable, any other auth the secret-write refusal (403); no list or read (404); the address gets nothing", async (t) => {
  withEnv(t, {}, [ORIGINS_ENV]);
  const elsewhere = await startFakeMcp();
  t.after(() => elsewhere.close());
  const s = await setup(t);
  const perRun = await s.token("PUT", "/settings/mcp-servers/gw", { url: elsewhere.url, auth: { type: "per_run" } });
  assert.deepEqual(issueOf(perRun), [422, "url", "not_an_option"], JSON.stringify(perRun.body));
  assert.match(perRun.body.error.fields[0].message, /AGENTRUN_MCP_TOKEN_ORIGINS/);
  for (const auth of [undefined, { type: "none" }, { type: "headers", headers: { "x-api-key": OTHER_KEY } }]) {
    const refused = await s.token("PUT", "/settings/mcp-servers/gw", { url: elsewhere.url, ...(auth ? { auth } : {}) });
    assert.equal(refused.status, 403, `${auth?.type}: ${JSON.stringify(refused.body)}`);
    assert.ok(String(refused.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), refused.body.error?.message);
  }
  assert.equal((await s.token("GET", "/settings/mcp-servers")).status, 404, "no list of its own");
  assert.equal((await s.token("GET", "/settings/mcp-servers/gw")).status, 404, "no read");
  assert.deepEqual(elsewhere.log, [], "the address got nothing");
  assert.deepEqual((await s.token("GET", "/settings/mcp-server-names")).body, { names: [] }, "nothing saved");
});

test("API-only: the token saves a per_run server at a listed https origin (200), keeping no credential and recording its toolkit; an apply's url notes need maps to it", async (t) => {
  const fake = await notesFake(t);
  const https = await overTls(t, fake);
  withEnv(t, { [ORIGINS_ENV]: `https://second.example,${originOf(https)}` });
  const { server, token } = await tokenServer(t, { templates: await notesTemplates(t) });
  const saved = await token("PUT", "/settings/mcp-servers/my-notes", { url: https, auth: { type: "per_run" }, toolkit: "notes" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.name, saved.body.auth?.type, saved.body.toolkit, saved.body.credential], ["my-notes", "per_run", "notes", null], JSON.stringify(saved.body));
  assert.ok(fake.log.some((entry) => entry.method === "tools/list"), "listed at its address");
  assert.equal((await server.store.mcp.server("my-notes")).sealed, null, "no credential kept");
  assert.deepEqual((await token("GET", "/settings/mcp-server-names")).body, { names: ["my-notes"] });

  const applied = await token("POST", "/templates/notes-digest/apply", { parameters: {}, grants: ["mcp:notes/list_notes"] });
  assert.equal(applied.status, 201, JSON.stringify(applied.body));
  assert.deepEqual(applied.body.servers, { notes: "my-notes" }, "the need {url, notes} maps to the server the token saved");
  assert.ok((await token("GET", `/agents/${applied.body.agent_id}`)).body.definition.tools.includes("mcp:my-notes/list_notes"));
});

test("API-only: the one listed loopback origin with AGENTRUN_MCP_ALLOW_LOOPBACK is 200; the same host on another port is 422 not_an_option and gets nothing; without the switch it counts for nothing", async (t) => {
  const listed = await startFakeMcp();
  t.after(() => listed.close());
  const otherPort = await startFakeMcp();
  t.after(() => otherPort.close());
  withEnv(t, { [ORIGINS_ENV]: originOf(listed.url) });
  const local = await tokenServer(t);
  const saved = await local.token("PUT", "/settings/mcp-servers/gw", { url: listed.url, auth: { type: "per_run" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const refused = await local.token("PUT", "/settings/mcp-servers/other", { url: otherPort.url, auth: { type: "per_run" } });
  assert.deepEqual(issueOf(refused), [422, "url", "not_an_option"], JSON.stringify(refused.body));
  assert.deepEqual(otherPort.log, [], "the other port got nothing");

  const hosted = await tokenServer(t, { mcpLoopback: false });
  const from = listed.log.length;
  const off = await hosted.token("PUT", "/settings/mcp-servers/gw", { url: listed.url, auth: { type: "per_run" } });
  assert.deepEqual(issueOf(off), [422, "url", "not_an_option"], JSON.stringify(off.body));
  assert.equal(listed.log.length, from, "nothing sent");
});

test("API-only: an address off the listed origins is 422 on url, naming no listed origin, before anything is sent: a lookalike, a sub- or superdomain, another port, a user, http to a listed https host, a path or query naming it", async (t) => {
  withEnv(t, { [ORIGINS_ENV]: "https://listed.example,https://second.example" });
  const { token } = await tokenServer(t);
  for (const url of [
    "https://listed.example.evil.test/mcp", "https://a.listed.example/mcp", "https://evillisted.example/mcp", "https://listed.example:8443/mcp",
    "https://evil.test/https://listed.example/mcp", "https://evil.test/mcp?next=https://listed.example",
  ]) {
    const refused = await token("PUT", "/settings/mcp-servers/gw", { url, auth: { type: "per_run" } });
    assert.deepEqual(issueOf(refused), [422, "url", "not_an_option"], `${url}: ${JSON.stringify(refused.body)}`);
    assert.equal(JSON.stringify(refused.body).includes("second.example"), false, "no listed origin named");
  }
  // A user in the address, or http to a host listed for https: refused as the address it is, before the list is read.
  for (const url of ["https://user@listed.example/mcp", "http://listed.example/mcp"]) {
    const refused = await token("PUT", "/settings/mcp-servers/gw", { url, auth: { type: "per_run" } });
    assert.deepEqual(issueOf(refused).slice(0, 2), [422, "url"], `${url}: ${JSON.stringify(refused.body)}`);
    assert.equal(JSON.stringify(refused.body).includes("second.example"), false, "no listed origin named");
  }
  assert.deepEqual((await token("GET", "/settings/mcp-server-names")).body, { names: [] }, "nothing saved");
});

test("API-only: at a listed origin, any auth but per_run is the secret-write refusal (403), and the address gets nothing", async (t) => {
  const listed = await startFakeMcp();
  t.after(() => listed.close());
  withEnv(t, { [ORIGINS_ENV]: originOf(listed.url) });
  const { token } = await tokenServer(t);
  for (const auth of [undefined, { type: "none" }, { type: "bearer", token: OTHER_KEY }, { type: "headers", headers: { "x-api-key": OTHER_KEY } }, { type: "oauth" }]) {
    const refused = await token("PUT", "/settings/mcp-servers/gw", { url: listed.url, ...(auth ? { auth } : {}) });
    assert.equal(refused.status, 403, `${auth?.type}: ${JSON.stringify(refused.body)}`);
    assert.ok(String(refused.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), refused.body.error?.message);
  }
  assert.deepEqual(listed.log, [], "the address got nothing");
});

test("claim: a per_run server the token saved, whose origin the runner no longer lists, refuses the run by name, and that host gets nothing; listed again, the claim goes on", async (t) => {
  const listed = await startFakeMcp();
  t.after(() => listed.close());
  withEnv(t, { [ORIGINS_ENV]: originOf(listed.url) });
  const { server, token } = await tokenServer(t);
  assert.equal((await token("PUT", "/settings/mcp-servers/mail", { url: listed.url, auth: { type: "per_run" } })).status, 200);
  const sent = listed.log.length;
  const store = server.store;
  const sealKey = Buffer.alloc(32, 7);
  // Each run as the server starts one: its revision pinned on the saved server, its launch record written (handed no
  // credential here, so a listed claim opens the server with none).
  const claimOf = async (runId) => {
    await store.agents.create({ id: `agent-${runId}`, name: `agent-${runId}` }, { id: `rev-${runId}`, kind: "agentic", body: { instructions: "Answer." }, mcpPin: await registryPin(store) });
    await store.runs.create({ id: runId, agentId: `agent-${runId}`, revisionId: `rev-${runId}` }, { body: { input: { content: "go" }, title: "go", place: { mode: "runner" } }, sealed: null });
    const claim = await store.claim(runId, "runner-a", { leaseMs: 60_000 });
    return mcpClaim({ store, claim, grants: ["mcp:mail/add"], sealKey, signal: new AbortController().signal, loopback: true });
  };
  // The operator took its origin off the list (here, the runner's environment, read at each claim): the run is refused
  // by the server's name.
  process.env[ORIGINS_ENV] = "https://elsewhere.example";
  await assert.rejects(claimOf("run-1"), (error) => {
    assert.match(error.message, /mail.*AGENTRUN_MCP_TOKEN_ORIGINS/, error.message);
    return true;
  });
  // Unset, the same.
  delete process.env[ORIGINS_ENV];
  await assert.rejects(claimOf("run-2"), /mail.*AGENTRUN_MCP_TOKEN_ORIGINS/);
  assert.equal(listed.log.length, sent, "that host got nothing after the save");
  // Listed again: the claim goes on (the run's own credential, none here, is what its calls would carry).
  process.env[ORIGINS_ENV] = originOf(listed.url);
  const step = await claimOf("run-3");
  t.after(() => step.release());
  assert.doesNotMatch(String(step.credentials.mail?.unopened ?? ""), /AGENTRUN_MCP_TOKEN_ORIGINS/);
  // Taken off the list mid-run: the resumed loop's fresh() opens the server again, and its calls are refused by its name,
  // unsent.
  process.env[ORIGINS_ENV] = "https://elsewhere.example";
  await step.fresh();
  assert.match(String(step.credentials.mail?.unopened ?? ""), /mail.*AGENTRUN_MCP_TOKEN_ORIGINS/);
  assert.equal(step.credentials.mail?.headers, undefined, "no headers to carry");
  assert.equal(listed.log.length, sent, "that host got nothing after the save");
});

/** A per-run bearer a run hands its per_run server (a fake value). */
const RUN_BEARER = `Bearer not-a-secret-${"per-run-bearer-0005"}`;
/** An inline run of `expert` granted the gw server's list_notes, handing it RUN_BEARER: its answer. */
const notesRun = (token, expert) => token("POST", "/runs", {
  external: { source: "backend", kind: "expert", id: expert, version: 1 },
  definition: { name: `Expert ${expert}`, instructions: "Answer.", skills: [], tools: ["mcp:gw/list_notes"], tool_settings: { "mcp:gw/list_notes": { permission: "allow" } }, harness: "pi" },
  input: { content: "List my notes." },
  mcp_auth: { gw: { headers: { authorization: RUN_BEARER } } },
});

test("API-only: a run of a per_run server the token saved, whose origin the server's list no longer holds, is refused before it starts (409 agent_not_runnable) by its name; no run starts, and that host gets nothing", async (t) => {
  const fake = await notesFake(t);
  withEnv(t, { [ORIGINS_ENV]: originOf(fake.url) });
  const first = await tokenServer(t);
  assert.equal((await first.token("PUT", "/settings/mcp-servers/gw", { url: fake.url, auth: { type: "per_run" } })).status, 200);
  const started = await notesRun(first.token, "notes-reader");
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const agent = started.body.agent_id;
  await first.server.stop();

  // The operator took the origin off the list and started the server again on the same data.
  process.env[ORIGINS_ENV] = "https://elsewhere.example";
  const again = await tokenServer(t, { data: first.server.data });
  const sent = fake.log.length;
  const before = (await again.token("GET", "/runs")).body.runs.length;
  // The agent its first run made, pinned already: refused at the run's start, inline or by the agent's own route.
  for (const refused of [await notesRun(again.token, "notes-reader"), await again.token("POST", `/agents/${agent}/runs`, { input: { content: "List my notes." }, mcp_auth: { gw: { headers: { authorization: RUN_BEARER } } } })]) {
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error?.code, "agent_not_runnable");
    assert.match(refused.body.error.message, /gw.*AGENTRUN_MCP_TOKEN_ORIGINS/, refused.body.error.message);
    assert.deepEqual(refused.body.error.fields?.map((issue) => [issue.field, issue.reason]), [["definition.tools[0]", "not_an_option"]]);
    assert.equal(JSON.stringify(refused.body).includes(RUN_BEARER), false, "the run's bearer is not echoed");
  }
  // An agent never run before: its save can't list the server to pin it, in the same words.
  const fresh = await notesRun(again.token, "notes-writer");
  assert.equal(fresh.status, 422, JSON.stringify(fresh.body));
  assert.match(JSON.stringify(fresh.body.error), /gw.*AGENTRUN_MCP_TOKEN_ORIGINS/);
  assert.equal((await again.token("GET", "/runs")).body.runs.length, before, "no run made");
  assert.equal(fake.log.length, sent, "that host got nothing");
});

test("API-only: a workflow revision granting a tool of a per_run server the token saved, whose origin the server's list no longer holds, is refused before it starts (409 agent_not_runnable) by the server's name; no run is made, and that host gets nothing", async (t) => {
  const fake = await notesFake(t);
  withEnv(t, { [ORIGINS_ENV]: originOf(fake.url) });
  const first = await tokenServer(t);
  assert.equal((await first.token("PUT", "/settings/mcp-servers/gw", { url: fake.url, auth: { type: "per_run" } })).status, 200);
  // A workflow revision that grants the server's tools, at its top level and on its model node (written to the store: a
  // workflow's save refuses an MCP grant, so this is one saved before that rule, or by hand).
  const flow = answerFlow();
  flow.root.steps[0].tools = ["mcp:gw/send_note"];
  await first.server.store.agents.create({ id: "flow-notes", name: "flow-notes" }, { id: "rev-flow-notes", kind: "workflow", body: { workflow: flow, tools: ["mcp:gw/list_notes"] } });
  await first.server.stop();

  // The operator took the origin off the list and started the server again on the same data.
  process.env[ORIGINS_ENV] = "https://elsewhere.example";
  const again = await tokenServer(t, { data: first.server.data });
  const sent = fake.log.length;
  const before = (await again.token("GET", "/runs")).body.runs.length;
  const refused = await again.token("POST", "/agents/flow-notes/runs", { input: { question: "What are my notes?" }, mcp_auth: { gw: { headers: { authorization: RUN_BEARER } } } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error?.code, "agent_not_runnable");
  assert.match(refused.body.error.message, /gw.*AGENTRUN_MCP_TOKEN_ORIGINS/, refused.body.error.message);
  assert.deepEqual(refused.body.error.fields?.map((issue) => [issue.field, issue.reason]), [["definition.tools[0]", "not_an_option"], ["definition.workflow", "not_an_option"]]);
  assert.equal(JSON.stringify(refused.body).includes(RUN_BEARER), false, "the run's bearer is not echoed");
  assert.equal((await again.token("GET", "/runs")).body.runs.length, before, "no run made");
  assert.equal(fake.log.length, sent, "that host got nothing");
});

test("API-only: the token's per_run save over a server it did not save (a row written by hand) is the secret-write refusal (403) at a listed origin: the row stays as it was, and the address gets nothing; over its own, 200", async (t) => {
  const listed = await startFakeMcp();
  t.after(() => listed.close());
  const elsewhere = await startFakeMcp();
  t.after(() => elsewhere.close());
  withEnv(t, { [ORIGINS_ENV]: originOf(listed.url) });
  const { server, token } = await tokenServer(t);
  await server.store.mcp.put({ name: "gw", url: elsewhere.url, auth: "none", tools: [ADD_TOOL], sealed: null });
  const refused = await token("PUT", "/settings/mcp-servers/gw", { url: listed.url, auth: { type: "per_run" } });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.ok(String(refused.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), refused.body.error?.message);
  assert.deepEqual([(await server.store.mcp.server("gw")).url, (await server.store.mcp.server("gw")).auth], [elsewhere.url, "none"], "the row stays as it was");
  assert.deepEqual(listed.log, [], "the address got nothing");

  assert.equal((await token("PUT", "/settings/mcp-servers/mine", { url: listed.url, auth: { type: "per_run" } })).status, 200);
  const over = await token("PUT", "/settings/mcp-servers/mine", { url: listed.url, auth: { type: "per_run" }, toolkit: "notes" });
  assert.equal(over.status, 200, JSON.stringify(over.body));
  assert.equal((await token("DELETE", "/settings/mcp-servers/mine")).status, 204, "the token's own, to delete");
});

test("store: the API-only token's held save over a row the token did not save, with the credential the gate read (per_run, none sealed), is 412, writing nothing: the row and its record stay as they were", async (t) => {
  const listed = await startFakeMcp();
  t.after(() => listed.close());
  const elsewhere = await startFakeMcp();
  t.after(() => elsewhere.close());
  const { McpServersOverStore } = await import("../dist/mcp-servers-store.js");
  const { saveMcpServer } = await import("../dist/mcp-store.js");
  const { mcpSourceKey } = await import("../dist/mcp-sources.js");
  const { credentialMark } = await import("../dist/mcp-secret-writes.js");
  const { store } = await storeOn(t);
  const seal = Buffer.alloc(32, 9);
  const registry = new McpServersOverStore(store, { AGENTRUN_SEAL_KEY: seal.toString("base64").replace(/=+$/, "") }, "test");
  registry.attach("http://127.0.0.1:1", "http://127.0.0.1:1", true);
  registry.apiOnly = true;
  registry.tokenOrigins = [originOf(listed.url)];
  // The gate read the token's own row and let the save through against its credential (per_run, none sealed); since, a
  // row the token did not save took its place (written by hand, no record) with that same credential, so the store's
  // conditional write alone would land on it.
  const hand = await saveMcpServer(store, seal, { name: "gw", url: elsewhere.url, auth: "per_run", tools: [] });
  await assert.rejects(registry.save("gw", { url: listed.url, auth: { type: "per_run" } }, undefined, credentialMark(hand), undefined, undefined, undefined, undefined, true), (error) => {
    assert.equal(error.code, "precondition_failed", error.message);
    return true;
  });
  const row = await store.mcp.server("gw");
  assert.deepEqual([row.url, row.auth], [elsewhere.url, "per_run"], "the row stays as it was");
  assert.equal(await store.settings.get(mcpSourceKey("gw")), undefined, "no record written");
});

/** A registry over a fresh store, as an API-only server (or, `apiOnly` false, a full one) holds it, its token's origins
 *  `origins`, and its store's clock. */
async function registryOn(t, origins, apiOnly = true) {
  const { McpServersOverStore } = await import("../dist/mcp-servers-store.js");
  // The store's clock, a test's own to move: a row written later is created later.
  const clock = { now: Date.UTC(2026, 10, 23) };
  const { store } = await storeOn(t, { clock });
  const seal = Buffer.alloc(32, 9);
  const registry = new McpServersOverStore(store, { AGENTRUN_SEAL_KEY: seal.toString("base64").replace(/=+$/, "") }, "test");
  registry.attach("http://127.0.0.1:1", "http://127.0.0.1:1", true);
  registry.apiOnly = apiOnly;
  registry.tokenOrigins = origins;
  return { store, seal, registry, clock };
}

test("store: the API-only token's held save that read a row the token did not save is 412 by its own check, even once the token's own row stands under the name with the credential the gate read: the row and its record stay the token's", async (t) => {
  const listed = await startFakeMcp();
  t.after(() => listed.close());
  const elsewhere = await startFakeMcp();
  t.after(() => elsewhere.close());
  const { saveMcpServer } = await import("../dist/mcp-store.js");
  const { storedSource } = await import("../dist/mcp-sources.js");
  const { credentialMark } = await import("../dist/mcp-secret-writes.js");
  const { store, seal, registry, clock } = await registryOn(t, [originOf(listed.url)]);
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
    await store.settings.put(mcpSourceKey("gw"), storedSource({ source: "url", toolkit: "notes" }, mine, false, true, true));
    return read;
  };
  await assert.rejects(registry.save("gw", { url: listed.url, auth: { type: "per_run" } }, undefined, credentialMark(hand), undefined, undefined, undefined, undefined, true), (error) => {
    assert.equal(error.code, "precondition_failed", error.message);
    return true;
  });
  assert.ok(mine && mine.createdAt !== hand.createdAt, "the token's row took the name between");
  assert.deepEqual(credentialMark(mine), credentialMark(hand), "with the credential the gate read");
  const record = await store.settings.get(mcpSourceKey("gw"));
  assert.deepEqual([record?.by, record?.listed, record?.toolkit, record?.of], ["token", true, "notes", mine.createdAt], "the record stays the token's, listed, as it was written");
});

test("store: the token's save over its own row saved at a listed origin, on a full server (no list holds it), keeps the row the token's and drops `listed`: no run's start or claim checks its origin from then on", async (t) => {
  const listed = await startFakeMcp();
  t.after(() => listed.close());
  const { saveMcpServer } = await import("../dist/mcp-store.js");
  const { storedSource, savedAtListedOrigin, savedByToken, tokenOriginRefusal } = await import("../dist/mcp-sources.js");
  const { credentialMark } = await import("../dist/mcp-secret-writes.js");
  const { store, seal, registry } = await registryOn(t, [], false);
  const row = await saveMcpServer(store, seal, { name: "gw", url: listed.url, auth: "per_run", tools: [] });
  await store.settings.put(mcpSourceKey("gw"), storedSource({ source: "url", toolkit: "notes" }, row, false, true, true));
  assert.ok(savedAtListedOrigin(await store.settings.get(mcpSourceKey("gw")), row.createdAt));
  // The token's ordinary save over it on the full server, naming no toolkit: no source of its own to write.
  await registry.save("gw", { url: listed.url, auth: { type: "per_run" } }, undefined, credentialMark(row), undefined, undefined, undefined, undefined, true);
  const saved = await store.mcp.server("gw");
  const record = await store.settings.get(mcpSourceKey("gw"));
  assert.ok(savedByToken(record, saved.createdAt), "still the token's");
  assert.equal(savedAtListedOrigin(record, saved.createdAt), false, "no longer marked saved at a listed origin");
  assert.deepEqual([record.source, record.toolkit, record.listed], ["url", "notes", undefined], "its source and toolkit kept");
  assert.equal(tokenOriginRefusal(record, { name: "gw", url: saved.url, createdAt: saved.createdAt }, ["https://elsewhere.example"]), undefined, "a list without its origin no longer refuses it");
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
async function handWritten(store, name, url, { perRun = false } = {}) {
  await store.mcp.put({ name, url, auth: "headers", tools: [ADD_TOOL], sealed: null });
  await store.settings.put(composioMadeKey(name), storedMade(envRecord(perRun), await store.mcp.server(name)));
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

test("claim: a row reading its key from COMPOSIO_API_KEY at an address off Composio's origin is refused by name, and that host gets nothing; on Composio's origin it carries the key", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const elsewhere = await startFakeMcp();
  t.after(() => elsewhere.close());
  const sealKey = Buffer.alloc(32, 7);
  const claimOf = async (store, runId, composioMcpOrigin) => {
    await queued(store, runId, { mcpPin: await registryPin(store) });
    const claim = await store.claim(runId, "runner-a", { leaseMs: 60_000 });
    return mcpClaim({ store, claim, grants: ["mcp:mail/add"], sealKey, signal: new AbortController().signal, loopback: true, composioMcpOrigin });
  };
  const { store } = await storeOn(t);
  await handWritten(store, "mail", elsewhere.url);
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
  // The agent its first run made, pinned already: refused at the run's start.
  const again = await inlineRun(s);
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error?.code, "agent_not_runnable");
  assert.match(again.body.error.message, /mail.*COMPOSIO_API_KEY/, again.body.error.message);
  assert.deepEqual(again.body.error.fields?.map((issue) => [issue.field, issue.reason]), [["definition.tools[0]", "missing"]]);
  // An agent never run before: its save can't list the server to pin it, in the same words.
  const fresh = await inlineRun(s, "mail-writer");
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
  const started = await inlineRun(s);
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
  assert.deepEqual(seam, ["runner/adapter-run-spec.ts", "runner/cli-run-spec.ts", "runner/mcp-claim.ts", "runner/mcp-run.ts", "runner/run-child-host.ts", "runner/run-child.ts", "server.ts"]);
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

// The listing probe: a per_run save's headers, at a listed origin alone, list its tools once and are kept nowhere.

/** A distinctive bearer the probe tests send (a fake), searched for whole and as its bare token. */
const PROBE_TOKEN = `probe-${"bearer-7c41e0d9a2f3"}`;
const PROBE_BEARER = `Bearer ${PROBE_TOKEN}`;
const perRunWith = (url) => ({ url, auth: { type: "per_run", headers: { authorization: PROBE_BEARER } } });

/** This process's stdout and stderr from now until the test ends: the server under test logs in it. */
function processOutput(t) {
  const err = serverLog(t);
  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = function (chunk, ...rest) {
    chunks.push(String(chunk));
    return write.call(process.stdout, chunk, ...rest);
  };
  t.after(() => void (process.stdout.write = write));
  return { text: () => err.text() + chunks.join("") };
}

/** A plain HTTP host on loopback, closed when the test ends, answering each request with `answer(req, res)` (a 404 by
 *  default): every connection and request it took is counted, whatever it was sent. */
async function plainHost(t, answer = (_req, res) => res.writeHead(404).end()) {
  const took = { connections: 0, requests: [] };
  const host = createServer((req, res) => {
    took.requests.push({ path: req.url, bearer: req.headers.authorization === PROBE_BEARER });
    req.resume();
    answer(req, res);
  });
  host.on("connection", () => (took.connections += 1));
  await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (host.close(resolve), host.closeAllConnections())));
  return { url: `http://127.0.0.1:${host.address().port}/mcp`, took };
}

test("API-only listing probe: a per_run save's headers at a listed origin list its tools and are kept nowhere (row, answer, store bytes, log); at an unlisted origin they are never sent", async (t) => {
  const sent = [];
  const fake = await startFakeMcp({ token: PROBE_TOKEN, inspect: (headers) => sent.push(headers.authorization) });
  t.after(() => fake.close());
  const unlisted = await plainHost(t);
  withEnv(t, { [ORIGINS_ENV]: originOf(fake.url) });
  const out = processOutput(t);
  const { server, token } = await tokenServer(t, { mcpLoopback: true });
  const saved = await token("PUT", "/settings/mcp-servers/gw", perRunWith(fake.url));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(saved.body.tools.some((tool) => tool.name === "add"), "listed with the bearer");
  assert.ok(sent.length > 0 && sent.every((one) => one === PROBE_BEARER), "the listing carried the bearer");
  assert.deepEqual([saved.body.auth.type, saved.body.credential], ["per_run", null]);
  assert.equal(JSON.stringify(saved.body).includes(PROBE_TOKEN), false, "the answer holds no bearer");
  const row = await server.store.mcp.server("gw");
  assert.deepEqual([row.auth, row.sealed ?? null], ["per_run", null], "the row seals no credential");
  assert.equal(JSON.stringify(row).includes(PROBE_TOKEN), false, "nor holds the bearer anywhere");
  assert.equal(storeBytes(server.data).includes(Buffer.from(PROBE_TOKEN)), false, "the store's bytes never hold it");
  // At an origin the list does not hold: refused before anything is sent there.
  const elsewhere = await token("PUT", "/settings/mcp-servers/other", perRunWith(unlisted.url));
  assert.deepEqual(issueOf(elsewhere), [422, "url", "not_an_option"], JSON.stringify(elsewhere.body));
  assert.equal(JSON.stringify(elsewhere.body).includes(PROBE_TOKEN), false);
  assert.deepEqual(unlisted.took, { connections: 0, requests: [] }, "the unlisted host got nothing");
  assert.equal(out.text().includes(PROBE_TOKEN), false, "the log never holds the bearer");
});

test("API-only listing probe: a listed server's 4xx or 5xx that echoes the bearer fails the save in words, and neither the answer nor the log holds it", async (t) => {
  let sent;
  let answer;
  const fake = await startFakeMcp({ token: PROBE_TOKEN, inspect: (headers) => (sent = headers.authorization), gate: (_url, message) => answer(message) });
  t.after(() => fake.close());
  withEnv(t, { [ORIGINS_ENV]: originOf(fake.url) });
  const out = processOutput(t);
  const { token } = await tokenServer(t, { mcpLoopback: true });
  const bare = () => sent.replace(/^Bearer\s+/, "");
  // Each echoes the header it was sent, whole and as its bare token: as a JSON-RPC error's words (which the SDK's error
  // carries), or as a body beside a status.
  const cases = [
    ["400 JSON-RPC", (message) => ({ status: 400, body: { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32600, message: `refused ${sent} (token ${bare()})` } } })],
    ["400", () => ({ status: 400, body: { error: `refused ${sent}`, token: bare() } })],
    ["403", () => ({ status: 403, body: { error: `refused ${sent}`, token: bare() } })],
    ["500", () => ({ status: 500, body: { error: `crashed holding ${sent}`, token: bare() } })],
    ["503 JSON-RPC", (message) => ({ status: 503, body: { jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: `down, holding ${sent} (token ${bare()})` } } })],
  ];
  for (const [at, [name, gate]] of cases.entries()) {
    answer = gate;
    sent = undefined;
    const failed = await token("PUT", `/settings/mcp-servers/gw${at}`, perRunWith(fake.url));
    assert.equal(sent, PROBE_BEARER, `${name}: the probe carried the bearer`);
    assert.ok(failed.status >= 400 && typeof failed.body.error?.message === "string" && failed.body.error.message.length > 0, `${name}: refused in words (${failed.status})`);
    assert.equal(JSON.stringify(failed.body).includes(PROBE_TOKEN), false, `${name}: the answer holds no bearer`);
  }
  assert.deepEqual((await token("GET", "/settings/mcp-server-names")).body, { names: [] }, "nothing saved");
  assert.equal(out.text().includes(PROBE_TOKEN), false, "the log never holds the bearer");
});

test("API-only listing probe: a listed server's 302 to another host is not followed: that host gets nothing, and the save fails in words holding no bearer", async (t) => {
  const second = await plainHost(t);
  const listed = await plainHost(t, (_req, res) => res.writeHead(302, { location: second.url }).end());
  // The listed origin alone: the host it points to is a second one, listed or not.
  withEnv(t, { [ORIGINS_ENV]: originOf(listed.url) });
  const out = processOutput(t);
  const { token } = await tokenServer(t, { mcpLoopback: true });
  const saved = await token("PUT", "/settings/mcp-servers/gw", perRunWith(listed.url));
  assert.deepEqual(issueOf(saved), [422, "url", "redirect"], JSON.stringify(saved.body));
  assert.match(saved.body.error.fields[0].message, /not followed/);
  assert.ok(listed.took.requests.length > 0 && listed.took.requests.every((one) => one.bearer), "the listed origin was asked, with the bearer");
  assert.deepEqual(second.took, { connections: 0, requests: [] }, "the host it pointed to got nothing");
  assert.equal(JSON.stringify(saved.body).includes(PROBE_TOKEN), false, "the answer holds no bearer");
  assert.deepEqual((await token("GET", "/settings/mcp-server-names")).body, { names: [] }, "nothing saved");
  assert.equal(out.text().includes(PROBE_TOKEN), false, "the log never holds the bearer");
});
