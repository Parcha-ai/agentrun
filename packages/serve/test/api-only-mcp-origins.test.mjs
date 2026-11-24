// A per_run MCP server saved by an API-only server's token at an origin the operator names
// (AGENTRUN_API_ONLY_MCP_ORIGINS, ServeOptions.apiOnlyMcpOrigins). Unset, the generic save is refused as before
// (api-only-mcp.test.mjs, "the token saves no server at an address of its own"). Set, the token saves a per_run server
// (which keeps no credential) at a listed origin alone. A body with a credential is the secret-write refusal (403).
// A per_run body at another origin, a body of another auth type, or a Composio preset's name is the refused route's own
// 404. A save over a server the token did not save, or one that seals a credential, is 403 (tokenWriteOverRefused). None
// of these refusals sends anything to the address. The list holds past the save: drop an origin and restart, and a run
// that grants a server the token saved there sends it nothing and says why. Unset, an API-only start holds an empty list
// (an upgrade): a per_run server the token saved on a full start is refused. A
// server the owner saved is not the list's, and a full start removes the list. Fake MCP servers on loopback, fake
// Composio, the faux MCP model. No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { follow, serve, storeBytes, withEnv } from "./support.mjs";
import { registryPin, storeOn } from "./store-helpers.mjs";

const { SECRET_WRITE_REFUSAL } = await import("../dist/secret-writes.js");
const { apiOnlyRefusal } = await import("../dist/api-only.js");
const { API_ONLY_MCP_ORIGINS_ENV, apiOnlyMcpOriginsFrom } = await import("../dist/env-switch.js");
const { mcpSourceKey, ownersRecord, storedSource } = await import("../dist/mcp-sources.js");
const { sealMcpCredential, sealRunMcpAuth } = await import("../dist/store/index.js");
const { holdApiOnlyMcpOrigins } = await import("../dist/mcp-api-only-origins.js");
const { mcpClaim } = await import("../dist/runner/mcp-claim.js");

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
async function setup(t, origins, more = {}) {
  const composio = await startFakeComposio({ apiKey: KEY, toolkits: { gmail: { no_auth: false, tools: [{ slug: "add", name: "Add", description: "Add two numbers." }] } }, mcpAccounts: {} });
  t.after(() => composio.close());
  const server = await serve(t, { faux: FAUX_MCP, apiOnly: true, apiOnlyMcpOrigins: typeof origins === "function" ? origins(composio) : origins, composioControl: { baseUrl: composio.baseUrl }, composioMcpOrigin: composio.mcpOrigin, ...more });
  const token = (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${server.token}` });
  return { server, token, composio };
}

const perRun = (url) => ({ url, auth: { type: "per_run", headers: { authorization: `Bearer ${LIST}` } } });
const OFF_LIST = "The MCP server contextforge can't be used: the API token saved it at an origin that is no longer on this server's AGENTRUN_API_ONLY_MCP_ORIGINS. Nothing was sent.";
/** An inline run (external `id`) granted contextforge's add, handed the run's own token. */
const runAdd = (s, id) => s.token("POST", "/runs", {
  external: { source: "backend", kind: "expert", id, version: 1 },
  definition: { name: `Expert ${id}`, instructions: "Answer.", skills: [], tools: ["mcp:contextforge/add"], tool_settings: { "mcp:contextforge/add": { permission: "allow" } }, harness: "pi" },
  input: { content: 'Call mcp__contextforge__add with {"a":2,"b":3}' },
  mcp_auth: { contextforge: { headers: { authorization: `Bearer ${RUN}` } } },
});
/** The words a run `ran` (runAdd's answer) was refused with: its error once it ended, or the refused start's body. */
const refusedWords = async (s, ran) => ran.status === 202
  ? ((await follow(s.server.api, ran.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 })), (await s.server.api("GET", `/runs/${ran.body.run_id}`)).body.error?.message)
  : JSON.stringify(ran.body);
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
  // A wildcard is refused in words that say so, not taken as a host that matches nothing.
  for (const wild of ["https://*.example.com", "*"]) {
    assert.throws(() => apiOnlyMcpOriginsFrom(`https://ok.example,${wild}`), (error) => error instanceof TypeError && /entry 2 is a wildcard, and wildcards are not supported/.test(error.message), wild);
  }
});

test("ServeOptions.apiOnlyMcpOrigins is read as the setting is: an origin written in capitals and with a trailing slash is the same origin, and the save is 200", async (t) => {
  const gw = await gateway(t);
  const s = await setup(t, [`${gw.origin.replace("http:", "HTTP:")}/`]);
  const saved = await s.token("PUT", PATH, perRun(gw.fake.url));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(await names(s), { names: ["contextforge"] });
});

test("the list holds past the save: restart with the origin still listed and a run reaches it; restart without it and a run granted its tool sends it nothing and says why, the run's revision pinned before or saved now", async (t) => {
  const gw = await gateway(t);
  const other = await gateway(t);
  const first = await setup(t, [gw.origin]);
  assert.equal((await first.token("PUT", PATH, perRun(gw.fake.url))).status, 200);
  await first.server.stop();

  // Still listed (beside another): the run calls add with its own token.
  const kept = await setup(t, [other.origin, gw.origin], { data: first.server.data });
  const ran = await runAdd(kept, "cf-1");
  assert.equal(ran.status, 202, JSON.stringify(ran.body));
  assert.equal((await follow(kept.server.api, ran.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 })).last.status, "completed", JSON.stringify((await kept.server.api("GET", `/runs/${ran.body.run_id}`)).body.error));
  assert.ok(gw.fake.log.some((entry) => entry.method === "tools/call" && entry.tool === "add"), "listed: the run called add");
  await kept.server.stop();

  // Dropped: the revision pinned above runs no call to it (its claim refused), and a new revision does not pin it.
  const dropped = await setup(t, [other.origin], { data: first.server.data });
  const from = gw.fake.log.length;
  const sent = gw.sent.length;
  const again = await runAdd(dropped, "cf-1");
  assert.equal(again.status, 202, JSON.stringify(again.body));
  assert.equal((await follow(dropped.server.api, again.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 })).last.status, "failed");
  assert.equal((await dropped.server.api("GET", `/runs/${again.body.run_id}`)).body.error?.message, OFF_LIST);
  const fresh = await runAdd(dropped, "cf-2");
  const words = fresh.status === 202
    ? ((await follow(dropped.server.api, fresh.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 })), (await dropped.server.api("GET", `/runs/${fresh.body.run_id}`)).body.error?.message)
    : JSON.stringify(fresh.body);
  assert.ok(String(words).includes(OFF_LIST.slice(0, -" Nothing was sent.".length)), `a new revision: ${words}`);
  assert.deepEqual([gw.fake.log.slice(from), gw.sent.slice(sent)], [[], []], "dropped: the address got nothing, no run's token among it");
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

/** A store with contextforge saved per_run by the API token, its origin listed, run-1 claimed and handed RUN, and the
 *  claim's MCP step over `wrap(store)`. */
async function goingClaim(t, wrap = (store) => store) {
  const { store } = await storeOn(t);
  const sealKey = Buffer.alloc(32, 7);
  const url = "https://mcp.example.com/mcp";
  const origin = new URL(url).origin;
  const add = { name: "add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } };
  await store.mcp.put({ name: "contextforge", url, auth: "per_run", tools: [add], sealed: null });
  // Saved by the API token, as the per_run save records it.
  await store.settings.put(mcpSourceKey("contextforge"), storedSource({ source: "url", toolkit: null }, await store.mcp.server("contextforge"), false, true));
  await holdApiOnlyMcpOrigins(store, true, [origin]);
  await store.agents.create({ id: "agent-1", name: "a" }, { id: "rev-1", kind: "agentic", body: {}, mcpPin: await registryPin(store) });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "go" }, title: "go", place: { mode: "runner" } }, sealed: sealRunMcpAuth(sealKey, "run-1", { contextforge: { headers: { authorization: `Bearer ${RUN}` }, origin } }) });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 600_000 });
  const step = await mcpClaim({ loopback: true, store: wrap(store), claim, grants: ["mcp:contextforge/add"], sealKey, signal: new AbortController().signal });
  t.after(() => step.release());
  const call = () => step.beforeCall("contextforge", new AbortController().signal);
  return { store, step, call, url, origin, handed: { url, headers: { authorization: `Bearer ${RUN}` } } };
}

test("a run already going: before each call of a per_run server the token saved, the origin list is read again; dropped since the claim (a runner of its own outlives the server's restart), the call gets only the refusal's words and no header; listed again, the run's own header is back", async (t) => {
  const { store, step, call, url, origin, handed } = await goingClaim(t);
  assert.deepEqual({ ...step.credentials.contextforge }, handed, "claimed with the origin listed: the run's own header");
  await call();
  assert.deepEqual({ ...step.credentials.contextforge }, handed, "still listed: a call keeps it");
  // The server restarted with the origin dropped; this runner's claim goes on.
  await holdApiOnlyMcpOrigins(store, true, ["https://other.example.com"]);
  await call();
  assert.deepEqual({ ...step.credentials.contextforge }, { url, unopened: OFF_LIST }, "dropped: the next call gets the words, no header");
  await call();
  assert.deepEqual({ ...step.credentials.contextforge }, { url, unopened: OFF_LIST }, "and every call after it");
  await holdApiOnlyMcpOrigins(store, true, [origin]);
  await call();
  assert.deepEqual({ ...step.credentials.contextforge }, handed, "listed again: the run's own header is back");
});

test("a run already going: when the origin list can't be read before a call (a store error), the call is refused unsent, never sent on the header the claim opened (the gateway refuses a check that throws)", async (t) => {
  let failing = false;
  // The store as the claim sees it: its settings reads fail on the API-only list once `failing` is set.
  const wrap = (store) => new Proxy(store, {
    get(target, key) {
      if (key === "settings") return new Proxy(target.settings, {
        get(settings, field) {
          if (field === "get") return async (name) => {
            if (failing && name === "mcp.api_only_origins") throw new Error("the store could not be read");
            return settings.get(name);
          };
          const value = Reflect.get(settings, field, settings);
          return typeof value === "function" ? value.bind(settings) : value;
        },
      });
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { call, handed, step } = await goingClaim(t, wrap);
  // A beforeCall that throws is the gateway's "could not be checked just now", the call unsent (store-github-app.test.mjs).
  await call();
  assert.deepEqual({ ...step.credentials.contextforge }, handed, "the read works: the call goes on the run's header");
  failing = true;
  await assert.rejects(call(), /the store could not be read/, "the read fails: the check throws, so the gateway refuses the call unsent");
});

test("an upgrade with the setting unset: an API-only start holds an empty list, so a per_run server the token saved on a full start is refused (a run granted it fails in the words, and nothing reaches the address)", async (t) => {
  const gw = await gateway(t);
  // A full start, as a backend saved its gateway with API-only off: the token's per_run save, marked the token's.
  const full = await serve(t, { runner: false });
  assert.equal((await full.api("PUT", PATH, perRun(gw.fake.url), { authorization: `Bearer ${full.token}` })).status, 200);
  await full.stop();

  // API-only with AGENTRUN_API_ONLY_MCP_ORIGINS unset: the CLI passes no apiOnlyMcpOrigins.
  const unset = await setup(t, undefined, { data: full.data });
  const from = gw.fake.log.length;
  const sent = gw.sent.length;
  const words = await refusedWords(unset, await runAdd(unset, "cf-up"));
  assert.ok(String(words).includes(OFF_LIST.slice(0, -" Nothing was sent.".length)), `refused: ${words}`);
  assert.deepEqual([gw.fake.log.slice(from), gw.sent.slice(sent)], [[], []], "the address got nothing, no run's token among it");
});

test("a per_run server the owner saved by hand on a full start is not the list's: an API-only start whose list leaves its origin out runs it with the run's own header", async (t) => {
  const gw = await gateway(t);
  // The owner's session saves it (no Authorization of the token's): its record carries no token mark.
  const full = await serve(t, { runner: false });
  assert.equal((await full.api("PUT", PATH, perRun(gw.fake.url))).status, 200);
  assert.notEqual((await full.store.settings.get(mcpSourceKey("contextforge")))?.by, "token", "the owner's");
  await full.stop();

  const s = await setup(t, ["https://other.example.com"], { data: full.data });
  const ran = await runAdd(s, "cf-own");
  assert.equal(ran.status, 202, JSON.stringify(ran.body));
  assert.equal((await follow(s.server.api, ran.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 })).last.status, "completed", JSON.stringify((await s.server.api("GET", `/runs/${ran.body.run_id}`)).body.error));
  assert.ok(gw.fake.log.some((entry) => entry.method === "tools/call" && entry.tool === "add"), "the run called add");
  assert.ok(gw.sent.includes(`Bearer ${RUN}`), "with the run's own header");
});

test("a full start on the store an API-only start held its list in removes the list: read afterwards, mcp.api_only_origins is undefined", async (t) => {
  const s = await setup(t, ["https://mcp.example.com"], { runner: false });
  assert.deepEqual(await s.server.store.settings.get("mcp.api_only_origins"), { origins: ["https://mcp.example.com"] }, "API-only: held");
  await s.server.stop();
  const full = await serve(t, { data: s.server.data, runner: false });
  assert.equal(await full.store.settings.get("mcp.api_only_origins"), undefined, "a full start: removed");
});
