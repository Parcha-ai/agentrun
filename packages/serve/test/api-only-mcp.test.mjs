// MCP servers on an API-only server (AGENTRUN_API_ONLY=1), which has no owner: its token saves a Composio server through
// the preset and deletes a server, and never writes a secret; the saved servers' names are its one listing
// (GET /settings/mcp-server-names). A Composio save names its key by the server's own environment variable
// (`api_key_env: "COMPOSIO_API_KEY"`, the one name taken): the server keeps that name, never the value, and reads the value
// at each use (the save's own calls to Composio, a run's connection, the delete's), and only ever sends it to Composio's
// origin, whatever a stored row says. Its generic save takes a per_run server alone, at an origin the operator listed in
// AGENTRUN_MCP_TOKEN_ORIGINS (exactly: https, or the one loopback origin with its port under AGENTRUN_MCP_ALLOW_LOOPBACK),
// keeping no credential and recording its toolkit; each claim of a server it saved checks that origin again. The list and
// the read stay refused there. The full profile is as before: its token's `api_key_env` is the one secret-write refusal.
// Fake Composio on loopback (fixtures/fake-composio.mjs, its MCP origin the composioMcpOrigin seam), fake MCP servers on
// loopback (one behind TLS with a certificate this process trusts), the faux MCP model (fixtures/faux-mcp.mjs). No key,
// no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { queued, registryPin, storeOn } from "./store-helpers.mjs";
import { asOwner, follow, scratch, serve, serverLog, storeBytes, withEnv } from "./support.mjs";

const { SECRET_WRITE_REFUSAL } = await import("../dist/secret-writes.js");
const { composioMadeKey, storedMade } = await import("../dist/composio-made.js");
const { mcpClaim } = await import("../dist/runner/mcp-claim.js");

const KEY_ENV = "COMPOSIO_API_KEY";
const KEY = `not-a-secret-${"composio-env-key-0001"}`;
const ROTATED = `not-a-secret-${"composio-env-key-0002"}`;
const OTHER = `not-a-secret-${"anthropic-env-key-0003"}`;
const OTHER_KEY = `not-a-secret-${"other-env-key-0004"}`;
const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const ADD = { slug: "add", name: "Add", description: "Add two numbers." };
const TOOLKITS = { gmail: { no_auth: false, tools: [ADD] } };
const USER_A = "grep-user-alice-0001";
const ACCOUNT_A = "ca_alice_gmail_0001";
const MCP_ACCOUNTS = { [USER_A]: [ACCOUNT_A] };
const CALL = 'Call mcp__mail__add with {"a":2,"b":3}';
const SAVE = { api_key_env: KEY_ENV, toolkit: "gmail", tools: ["add"], user_id: "per_run" };

/** A server (API-only unless `full`) beside a fake Composio whose key is KEY, and the log. */
async function setup(t, { full = false } = {}) {
  const composio = await startFakeComposio({ apiKey: KEY, toolkits: TOOLKITS, mcpAccounts: MCP_ACCOUNTS });
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
