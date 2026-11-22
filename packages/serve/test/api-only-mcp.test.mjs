// MCP servers on an API-only server (AGENTRUN_API_ONLY=1), which has no owner: its token lists them, reads one, saves a
// Composio server through the preset and a per_run URL server, and deletes them, and never writes a secret. A Composio save
// names its key by the server's own environment variable (`api_key_env: "COMPOSIO_API_KEY"`, the one name taken): the
// server keeps that name, never the value, and reads the value at each use (the save's own calls to Composio, a run's
// connection, the delete's). A per_run URL server keeps no credential, and is taken at an https address only. The full
// profile is as before: its token's `api_key_env` is the one secret-write refusal. Fake Composio on loopback
// (fixtures/fake-composio.mjs), the faux MCP model (fixtures/faux-mcp.mjs), a fake MCP server behind TLS made here. No key,
// no network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { asOwner, follow, serve, serverLog, storeBytes, withEnv } from "./support.mjs";

const { SECRET_WRITE_REFUSAL } = await import("../dist/secret-writes.js");
const { composioMadeKey } = await import("../dist/composio-made.js");

const KEY_ENV = "COMPOSIO_API_KEY";
const KEY = `not-a-secret-${"composio-env-key-0001"}`;
const ROTATED = `not-a-secret-${"composio-env-key-0002"}`;
const OTHER = `not-a-secret-${"anthropic-env-key-0003"}`;
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
  const server = await serve(t, { faux: FAUX_MCP, composioControl: { baseUrl: composio.baseUrl }, ...(full ? {} : { apiOnly: true }) });
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

test("API-only: the token saves a per-run Composio server by api_key_env; the listing and the read show its name, kind, toolkit and tools, no credential and no query; the store holds the name, never the value; the delete reaches Composio with the variable's value", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t);
  const saved = await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.ok(s.composio.calls.length > 0 && s.composio.calls.every((call) => call.keyOk), "every call the save made to Composio carried the variable's value");

  const listed = await s.token("GET", "/settings/mcp-servers");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const [server] = listed.body.servers;
  assert.deepEqual({ name: server.name, kind: server.kind, auth: server.auth, toolkit: server.toolkit }, { name: "mail", kind: "composio", auth: { type: "headers", api_key_env: KEY_ENV }, toolkit: "gmail" });
  assert.ok(server.tools.includes("add") && server.tools.every((tool) => typeof tool === "string"), `its tools by name: ${JSON.stringify(server.tools)}`);
  assert.equal(server.credential, undefined, "no credential in the listing");
  assert.equal(String(server.url ?? "").includes("?"), false, `no query in its address: ${server.url}`);
  assert.deepEqual({ name: server.secret?.name, set: server.secret?.set, source: server.secret?.source }, { name: "mcp:mail", set: true, source: "env" }, "its key as every secret is read: by name, set, from the environment");
  const one = await s.token("GET", "/settings/mcp-servers/mail");
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.deepEqual(one.body, server, "the read is the listing's entry");
  assert.deepEqual(saved.body.server, server, "and so is the save's answer");

  const row = await s.server.store.mcp.server("mail");
  assert.equal(row.sealed, null, "the row seals no credential");
  assert.equal(new URL(row.url).searchParams.has("user_id"), false, "and its address names no user");
  const record = await s.server.store.settings.get(composioMadeKey("mail"));
  assert.equal(record.key_env, KEY_ENV, "its record names the variable");
  await s.server.store.flush();
  assert.equal(storeBytes(s.server.data).includes(Buffer.from(KEY)), false, "the store's bytes never hold the key");
  assert.equal(JSON.stringify([saved.body, listed.body, one.body, record]).includes(KEY), false, "no answer or record holds the key");
  assert.equal(s.log.text().includes(KEY), false, "no log line holds the key");

  const from = s.composio.calls.length;
  const deleted = await s.token("DELETE", "/settings/mcp-servers/mail");
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.composio?.removed, true, `what the save made at Composio is removed with the variable's value: ${JSON.stringify(deleted.body)}`);
  const sent = s.composio.calls.slice(from);
  assert.ok(sent.some((call) => call.method === "DELETE") && sent.every((call) => call.keyOk), "the delete's calls carried the variable's value");
  assert.equal((await s.token("GET", "/settings/mcp-servers")).body.servers.length, 0, "gone");
});

test("API-only: api_key_env naming another variable is 422 invalid naming COMPOSIO_API_KEY, and nothing is sent to Composio", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY, ANTHROPIC_API_KEY: OTHER });
  const s = await setup(t);
  const refused = await s.token("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, api_key_env: "ANTHROPIC_API_KEY" });
  const issue = refused.body.error?.fields?.[0];
  assert.deepEqual([refused.status, issue?.field, issue?.reason], [422, "api_key_env", "invalid"], JSON.stringify(refused.body));
  assert.match(issue.message, /COMPOSIO_API_KEY/, "the message names the one variable taken");
  assert.equal(JSON.stringify(refused.body).includes(OTHER), false, "never the other variable's value");
  assert.deepEqual(s.composio.calls, [], "nothing sent to Composio");
  assert.equal((await s.token("GET", "/settings/mcp-servers")).body.servers.length, 0, "nothing saved");
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

/** A self-signed certificate for 127.0.0.1, made with openssl in a folder of its own. */
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

test("API-only: the token saves a per_run URL server at an https address (200), keeping no credential; http, or another auth type, is 422 and nothing is saved", async (t) => {
  const fake = await startFakeMcp();
  t.after(() => fake.close());
  const s = await setup(t);
  const https = await overTls(t, fake);
  const saved = await s.token("PUT", "/settings/mcp-servers/gw", { url: https, auth: { type: "per_run" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual({ name: saved.body.name, kind: saved.body.kind, auth: saved.body.auth, toolkit: saved.body.toolkit }, { name: "gw", kind: "url", auth: { type: "per_run" }, toolkit: null });
  assert.ok(saved.body.tools.includes("add"), `its tools by name: ${JSON.stringify(saved.body.tools)}`);
  assert.equal((await s.server.store.mcp.server("gw")).sealed, null, "no credential kept");

  const http = await s.token("PUT", "/settings/mcp-servers/plain", { url: fake.url, auth: { type: "per_run" } });
  assert.deepEqual([http.status, http.body.error?.fields?.[0]?.field], [422, "url"], JSON.stringify(http.body));
  assert.match(http.body.error.fields[0].message, /https/);
  for (const auth of [{ type: "none" }, { type: "github_app" }]) {
    const other = await s.token("PUT", "/settings/mcp-servers/other", { url: https, auth });
    assert.deepEqual([other.status, other.body.error?.fields?.[0]?.field], [422, "auth.type"], `${auth.type}: ${JSON.stringify(other.body)}`);
  }
  assert.deepEqual((await s.token("GET", "/settings/mcp-servers")).body.servers.map((one) => one.name), ["gw"], "nothing else saved");
  assert.equal((await s.token("DELETE", "/settings/mcp-servers/gw")).status, 204, "and the token deletes it");
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
