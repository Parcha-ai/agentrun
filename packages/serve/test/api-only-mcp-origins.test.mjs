// A per_run MCP server saved by an API-only server's token at an origin the operator names
// (AGENTRUN_API_ONLY_MCP_ORIGINS, ServeOptions.apiOnlyMcpOrigins). Unset, the generic save is refused as before
// (api-only-mcp.test.mjs, "the token saves no server at an address of its own"). Set, the token saves a per_run server
// (which keeps no credential) at a listed origin alone. A body with a credential is the secret-write refusal (403).
// A per_run body at another origin, a body of another auth type, or a Composio preset's name is the refused route's own
// 404. A save over a server the token did not save, or one that seals a credential, is 403 (tokenWriteOverRefused). None
// of these refusals sends anything to the address. Fake MCP servers on loopback, fake Composio, the faux MCP model.
// No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { follow, serve, storeBytes, withEnv } from "./support.mjs";

const { SECRET_WRITE_REFUSAL } = await import("../dist/secret-writes.js");
const { apiOnlyRefusal, apiOnlyMcpOriginsFrom } = await import("../dist/api-only.js");
const { mcpSourceKey, ownersRecord } = await import("../dist/mcp-sources.js");
const { sealMcpCredential } = await import("../dist/store/index.js");

const LIST = `not-a-secret-${"cf-list-token-0001"}`;
const RUN = `not-a-secret-${"cf-run-token-0002"}`;
const OTHER = `not-a-secret-${"cf-other-token-0003"}`;
const KEY_ENV = "COMPOSIO_API_KEY";
const KEY = `not-a-secret-${"composio-env-key-0004"}`;
const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const PATH = "/settings/mcp-servers/contextforge";

/** A fake MCP server that lists its tools to LIST and RUN, and keeps every Authorization it was sent. */
async function gateway(t) {
  const sent = [];
  const fake = await startFakeMcp({ token: (authorization) => (sent.push(authorization), [`Bearer ${LIST}`, `Bearer ${RUN}`].includes(authorization)) });
  t.after(() => fake.close());
  return { fake, sent, origin: new URL(fake.url).origin };
}

/** An API-only server whose list of MCP origins is `origins` (or what `origins` makes of the fake Composio beside it);
 *  requests with its API token. */
async function setup(t, origins) {
  const composio = await startFakeComposio({ apiKey: KEY, toolkits: { gmail: { no_auth: false, tools: [{ slug: "add", name: "Add", description: "Add two numbers." }] } }, mcpAccounts: {} });
  t.after(() => composio.close());
  const server = await serve(t, { faux: FAUX_MCP, apiOnly: true, apiOnlyMcpOrigins: typeof origins === "function" ? origins(composio) : origins, composioControl: { baseUrl: composio.baseUrl }, composioMcpOrigin: composio.mcpOrigin });
  const token = (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${server.token}` });
  return { server, token, composio };
}

const perRun = (url) => ({ url, auth: { type: "per_run", headers: { authorization: `Bearer ${LIST}` } } });
const names = async (s) => (await s.token("GET", "/settings/mcp-server-names")).body;
const rowOf = async (store, name) => {
  const row = await store.mcp.server(name);
  return row && { url: row.url, auth: row.auth, createdAt: row.createdAt, updatedAt: row.updatedAt, sealed: row.sealed, credentialChangedAt: row.credentialChangedAt };
};

test("the setting: unset or blank is no origin; each comma-separated entry is an http(s) origin, kept once; a path, a query, a user or a non-URL stops the start, naming the entry by place, never its text", () => {
  for (const blank of [undefined, "", " ", " , "]) assert.deepEqual(apiOnlyMcpOriginsFrom(blank), [], JSON.stringify(blank));
  assert.deepEqual(apiOnlyMcpOriginsFrom("http://127.0.0.1:4001, https://Gateway.Example:443/,http://127.0.0.1:4001"), ["http://127.0.0.1:4001", "https://gateway.example"]);
  for (const bad of ["http://127.0.0.1:4001/mcp", "https://gw.example?x=1", Object.assign(new URL("https://gw.example"), { username: "user", password: OTHER }).href, "gw.example", "ftp://gw.example", "https://gw.example#a"]) {
    assert.throws(() => apiOnlyMcpOriginsFrom(`https://ok.example,${bad}`), (error) => error instanceof TypeError && /AGENTRUN_API_ONLY_MCP_ORIGINS/.test(error.message) && /entry 2/.test(error.message) && !error.message.includes(bad), bad);
  }
});

test("API-only with the address's origin listed: the token saves contextforge as per_run (200), the names route lists it, nothing of a credential is kept, and a run handed mcp_auth reaches it with its own token", async (t) => {
  const gw = await gateway(t);
  const s = await setup(t, [gw.origin]);
  const saved = await s.token("PUT", PATH, perRun(gw.fake.url));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual([saved.body.auth?.type, saved.body.credential], ["per_run", null], "per_run, keeping nothing");
  assert.deepEqual(await names(s), { names: ["contextforge"] });
  const store = s.server.store;
  assert.equal((await store.mcp.server("contextforge")).sealed, null, "no credential in its row");
  await store.flush();
  assert.equal(storeBytes(s.server.data).includes(Buffer.from(LIST)), false, "the listing's token is in no stored byte");

  const run = await s.token("POST", "/runs", {
    external: { source: "backend", kind: "expert", id: "cf-1", version: 1 },
    definition: { name: "Expert cf-1", instructions: "Answer.", skills: [], tools: ["mcp:contextforge/add"], tool_settings: { "mcp:contextforge/add": { permission: "allow" } }, harness: "pi" },
    input: { content: 'Call mcp__contextforge__add with {"a":2,"b":3}' },
    mcp_auth: { contextforge: { headers: { authorization: `Bearer ${RUN}` } } },
  });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  await follow(s.server.api, run.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.ok(gw.fake.log.some((entry) => entry.method === "tools/call" && entry.tool === "add"), "the run called the gateway's add");
  assert.ok(gw.sent.includes(`Bearer ${RUN}`), "with the run's own token");
});

test("API-only with the origin listed: a save that carries a credential (headers, a bearer token) is the secret-write refusal (403), and the address gets nothing", async (t) => {
  const gw = await gateway(t);
  const s = await setup(t, [gw.origin]);
  for (const auth of [{ type: "headers", headers: { authorization: `Bearer ${OTHER}` } }, { type: "bearer", token: OTHER }]) {
    const refused = await s.token("PUT", PATH, { url: gw.fake.url, auth });
    assert.equal(refused.status, 403, `${auth.type}: ${JSON.stringify(refused.body)}`);
    assert.ok(String(refused.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), refused.body.error?.message);
  }
  assert.deepEqual(gw.fake.log, [], "the address got nothing");
  assert.deepEqual(await names(s), { names: [] }, "nothing saved");
});

test("API-only with one origin listed: a per_run save at another origin, a save of another auth type at the listed one, or one with no auth is the refused route's 404, and no address gets anything", async (t) => {
  const gw = await gateway(t);
  const elsewhere = await gateway(t);
  const s = await setup(t, [gw.origin]);
  const refusal = apiOnlyRefusal(`/v2${PATH}`);
  for (const [why, body] of [["another origin", perRun(elsewhere.fake.url)], ["auth none", { url: gw.fake.url, auth: { type: "none" } }], ["no auth", { url: gw.fake.url }]]) {
    const refused = await s.token("PUT", PATH, body);
    assert.deepEqual([refused.status, refused.body.error?.message], [404, refusal], `${why}: ${JSON.stringify(refused.body)}`);
  }
  assert.deepEqual([gw.fake.log, elsewhere.fake.log], [[], []], "no address got anything");
  assert.deepEqual(await names(s), { names: [] }, "nothing saved");
  assert.equal((await s.token("GET", "/settings/mcp-servers")).status, 404, "still no list of its own");
  assert.equal((await s.token("GET", PATH)).status, 404, "still no read");
});

test("API-only with the origin listed: the token's per_run save over a server it did not save, or over one that seals a credential, is 403; the row is unchanged and the address gets nothing", async (t) => {
  const gw = await gateway(t);
  const s = await setup(t, [gw.origin]);
  const store = s.server.store;
  assert.equal((await s.token("PUT", PATH, perRun(gw.fake.url))).status, 200);
  // The owner's: its record without the token's mark.
  await store.settings.put(mcpSourceKey("contextforge"), ownersRecord(await store.settings.get(mcpSourceKey("contextforge"))));
  // One that seals a credential, written as a store holding one would have it, and carrying the token's mark: refused for
  // the credential alone.
  await store.mcp.put({ name: "sealed", url: gw.fake.url, auth: "headers", tools: [], sealed: sealMcpCredential(randomBytes(32), "sealed", { type: "headers", headers: { authorization: `Bearer ${OTHER}` } }, gw.fake.url) });
  await store.settings.put(mcpSourceKey("sealed"), { url: gw.fake.url, of: (await store.mcp.server("sealed")).createdAt, by: "token" });
  await store.flush?.();
  const from = gw.fake.log.length;
  for (const name of ["contextforge", "sealed"]) {
    const before = await rowOf(store, name);
    const refused = await s.token("PUT", `/settings/mcp-servers/${name}`, perRun(gw.fake.url));
    assert.equal(refused.status, 403, `${name}: ${JSON.stringify(refused.body)}`);
    assert.ok(String(refused.body.error?.message).startsWith(SECRET_WRITE_REFUSAL), refused.body.error?.message);
    assert.deepEqual(await rowOf(store, name), before, `${name}: the row is unchanged`);
  }
  assert.deepEqual(gw.fake.log.slice(from), [], "the address got nothing");
});

test("API-only with Composio's MCP origin listed: a Composio preset's name through the generic save is the refused route's 404; nothing reaches Composio and the row is unchanged", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const listed = await setup(t, (composio) => [new URL(composio.mcpOrigin).origin]);
  assert.equal((await listed.token("PUT", "/settings/mcp-servers/mail/composio", { api_key_env: KEY_ENV, toolkit: "gmail", tools: ["add"], user_id: "per_run" })).status, 200);
  const row = await listed.server.store.mcp.server("mail");
  const before = await rowOf(listed.server.store, "mail");
  const from = listed.composio.calls.length;
  const refused = await listed.token("PUT", "/settings/mcp-servers/mail", perRun(row.url));
  assert.deepEqual([refused.status, refused.body.error?.message], [404, apiOnlyRefusal("/v2/settings/mcp-servers/mail")], JSON.stringify(refused.body));
  assert.deepEqual(listed.composio.calls.slice(from), [], "nothing reached Composio");
  assert.deepEqual(await rowOf(listed.server.store, "mail"), before, "the row is unchanged");
});
