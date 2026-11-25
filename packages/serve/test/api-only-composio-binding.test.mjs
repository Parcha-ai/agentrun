// A run's Composio binding on an API-only server (AGENTRUN_API_ONLY=1), whose every caller is its API token: a per-run
// Composio server's run calls as the composio_user_id and connected_account_id its caller hands in mcp_auth, so there the
// user must be one in the token's own namespace (`agentrun.token.`), and a named account one Composio lists under that
// user, read at the start (or the message) that hands it, refused when Composio can't answer. The claim refuses a
// binding outside the namespace too (one sealed before this rule), and a Composio server the token saved whose address
// calls as a user outside it (one saved before the namespace). The owner's runs, on the full profile, are as before.
// Fake Composio on loopback (fixtures/fake-composio.mjs, its MCP origin the composioMcpOrigin seam), the faux MCP model
// (fixtures/faux-mcp.mjs). No key, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { registryPin, storeOn } from "./store-helpers.mjs";
import { asOwner, follow, serve, serverLog, withEnv } from "./support.mjs";

const { composioMadeKey, storedMade } = await import("../dist/composio-made.js");
const { mcpSourceKey, storedSource } = await import("../dist/mcp-sources.js");
const { sealRunMcpAuth } = await import("../dist/store/index.js");
const { holdApiOnlyMcpOrigins } = await import("../dist/mcp-api-only-origins.js");
const { mcpClaim } = await import("../dist/runner/mcp-claim.js");

const KEY_ENV = "COMPOSIO_API_KEY";
const KEY = `not-a-secret-${"composio-env-key-0101"}`;
const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const ADD = { slug: "add", name: "Add", description: "Add two numbers." };
const ADD_TOOL = { name: "add", title: "Add", description: "Add two numbers.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, annotations: { readOnlyHint: true } };
const CALL = 'Call mcp__mail__add with {"a":2,"b":3}';
const SAVE = { api_key_env: KEY_ENV, toolkit: "gmail", tools: ["add"], user_id: "per_run" };
const MANAGED = "ac_shared_managed_gmail";
/** The owner's Composio user, with an ACTIVE gmail account under the shared managed auth config: connected in Composio's
 *  dashboard (no row here at all), so no saved server stands on that config. */
const OWNER = "owner-ops";
const OWNERS_ACCOUNT = "ca_x_owner_gmail";
/** A user in the token's namespace, with an account of its own. */
const TOKENS = "agentrun.token.ops";
const TOKENS_ACCOUNT = "ca_token_ops_gmail";
const ACCOUNTS = { gmail: [{ status: "ACTIVE", auth_config: MANAGED, id: OWNERS_ACCOUNT, user: OWNER }, { status: "ACTIVE", auth_config: MANAGED, id: TOKENS_ACCOUNT, user: TOKENS }] };
const FAKE = { authConfigs: { gmail: [{ id: MANAGED, is_composio_managed: true, status: "ENABLED" }] }, accounts: ACCOUNTS, mcpAccounts: { [OWNER]: [OWNERS_ACCOUNT], [TOKENS]: [TOKENS_ACCOUNT] } };

/** A server (API-only unless `full`) beside a fake Composio whose key is KEY (`fake`: more of its options), and the log. */
async function setup(t, { full = false, fake = {} } = {}) {
  const composio = await startFakeComposio({ apiKey: KEY, toolkits: { gmail: { no_auth: false, tools: [ADD] } }, ...FAKE, ...fake });
  t.after(() => composio.close());
  const log = serverLog(t);
  const server = await serve(t, { faux: FAUX_MCP, composioControl: { baseUrl: composio.baseUrl }, composioMcpOrigin: composio.mcpOrigin, ...(full ? {} : { apiOnly: true }) });
  const token = (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${server.token}` });
  return { composio, log, server, token };
}

/** An inline run granted mail's `add`, bound as `binding` (mcp_auth.mail), by `as` (the token by default). */
const runAs = (as, binding, expert = "mail-reader") => as("POST", "/runs", {
  external: { source: "backend", kind: "expert", id: expert, version: 1 },
  definition: { name: `Expert ${expert}`, instructions: "Answer.", skills: [], tools: ["mcp:mail/add"], tool_settings: { "mcp:mail/add": { permission: "allow" } }, harness: "pi" },
  input: { content: CALL },
  mcp_auth: { mail: binding },
});
const runCount = async (s) => (await s.token("GET", "/runs")).body.runs.length;
const answerOf = async (s, id) => {
  await follow(s.server.api, id, ["completed", "failed"], { deadlineMs: 60_000 });
  const view = (await s.token("GET", `/runs/${id}`)).body;
  return String(view.result?.final_answer ?? JSON.stringify(view.result ?? view.error));
};
const lookups = (s, from = 0) => s.composio.calls.slice(from).filter((call) => call.method === "GET" && call.path === "/api/v3/connected_accounts");

// The review's scenario: the token saves a per_run server under the shared managed config (no owner server stands on it,
// so the save is 200), then runs it as the owner's user and account. Each binding outside the token's own is refused at
// the start, in its field's words, before a run is made, and nothing reaches Composio's MCP endpoint.
const REFUSED = [
  ["the owner's user and account", { composio_user_id: OWNER, connected_account_id: OWNERS_ACCOUNT }, "composio_user_id"],
  ["the owner's user, no account", { composio_user_id: OWNER }, "composio_user_id"],
  ["the namespace's prefix in another letter case", { composio_user_id: "Agentrun.Token.ops", connected_account_id: TOKENS_ACCOUNT }, "composio_user_id"],
  ["a user in the namespace, with the owner's account", { composio_user_id: "agentrun.token.other", connected_account_id: OWNERS_ACCOUNT }, "connected_account_id"],
  ["a user in the namespace, with another namespaced user's account", { composio_user_id: "agentrun.token.other", connected_account_id: TOKENS_ACCOUNT }, "connected_account_id"],
  ["a user in the namespace, with an account Composio doesn't list", { composio_user_id: TOKENS, connected_account_id: "ca_nobody_listed" }, "connected_account_id"],
  ["the namespace's bare prefix, nothing after it", { composio_user_id: "agentrun.token." }, "composio_user_id"],
  // A Composio answering every user's accounts, whatever user_ids asks: the owner's comes back under the owner's user.
  ["a user in the namespace, with the owner's account Composio answers under the owner's user", { composio_user_id: TOKENS, connected_account_id: OWNERS_ACCOUNT }, "connected_account_id", { ignoreUserIds: true }],
];
// Each refusal says which check refused it.
const WHICH = { composio_user_id: /outside the API token's Composio namespace.*API token's own.*agentrun\.token\./, connected_account_id: /not listed under this run's composio_user_id.*Composio lists/ };
for (const [shape, binding, field, fake] of REFUSED) {
  test(`API-only: a run bound to ${shape} is 422 not_allowed under mcp_auth.mail.${field}; no run is made and nothing reaches Composio's MCP endpoint`, async (t) => {
    withEnv(t, { [KEY_ENV]: KEY });
    const s = await setup(t, { fake });
    const saved = await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const before = await runCount(s);
    const run = await runAs(s.token, binding);
    assert.equal(run.status, 422, JSON.stringify(run.body));
    assert.deepEqual(run.body.error?.fields?.map((issue) => [issue.field, issue.reason]), [[`mcp_auth.mail.${field}`, "not_allowed"]], JSON.stringify(run.body.error));
    assert.match(run.body.error.fields[0].message, WHICH[field], run.body.error.fields[0].message);
    // (The bare prefix is in the refusal's own words, which name the namespace.)
    for (const value of [binding.composio_user_id, binding.connected_account_id, KEY].filter((value) => value && value !== "agentrun.token.")) assert.equal(JSON.stringify(run.body).includes(value), false, `the refusal never quotes ${value}`);
    assert.equal(await runCount(s), before, "no run made");
    nothingAsBound(s, binding);
  });
}

/** No request to Composio's MCP endpoint called a tool, or named the bound user or account (the agent's save lists the
 *  server's tools at its own address, which names neither). */
function nothingAsBound(s, binding) {
  assert.deepEqual(s.composio.mcpLog.filter((entry) => entry.method === "tools/call"), [], "no tool was called");
  const named = [binding.composio_user_id, binding.connected_account_id].filter(Boolean).map(encodeURIComponent);
  assert.deepEqual(s.composio.mcpLog.filter((entry) => named.some((value) => String(entry.path).includes(value))), [], "no MCP request named the bound user or account");
}

test("API-only: a run bound to a user in the token's namespace and an account Composio lists under it starts (202) and calls as them; the lookup names that user, with the server's key", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t);
  assert.equal((await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE)).status, 200);
  const from = s.composio.calls.length;
  const run = await runAs(s.token, { composio_user_id: TOKENS, connected_account_id: TOKENS_ACCOUNT });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  assert.match(await answerOf(s, run.body.run_id), /The tool said: 5/);
  const read = lookups(s, from);
  assert.ok(read.length >= 1, "the start read the user's accounts");
  assert.deepEqual([...new Set(read.map((call) => call.query?.user_ids))], [TOKENS], "for the bound user alone");
  assert.ok(read.every((call) => call.keyOk), "with the server's key");
  // No account named: the namespace alone, nothing to look up.
  const bare = await runAs(s.token, { composio_user_id: TOKENS }, "mail-writer");
  assert.equal(bare.status, 202, JSON.stringify(bare.body));
});

test("API-only: a run bound to an account in the token's namespace is refused when Composio's account listing fails, fail closed: no run is made and nothing reaches its MCP endpoint", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { fake: { fail: { path: "/api/v3/connected_accounts", status: 500 } } });
  assert.equal((await s.token("PUT", "/settings/mcp-servers/mail/composio", SAVE)).status, 200);
  const before = await runCount(s);
  const binding = { composio_user_id: TOKENS, connected_account_id: TOKENS_ACCOUNT };
  const run = await runAs(s.token, binding);
  assert.equal(run.status, 424, JSON.stringify(run.body));
  assert.equal(run.body.error?.code, "upstream_failed");
  assert.match(run.body.error.message, /Composio didn't answer the check.*mail.*never taken unchecked/, run.body.error.message);
  assert.equal(JSON.stringify(run.body).includes(KEY), false);
  assert.equal(await runCount(s), before, "no run made");
  nothingAsBound(s, binding);
});

// The listing is read 50 a page, at most 10 pages, as the save's is: here the fake answers one a page, so an account on
// the 10th page is found and one past it is never taken unchecked.
const fillers = (n) => Array.from({ length: n }, (_, i) => ({ status: "ACTIVE", auth_config: MANAGED, id: `ca_token_ops_filler_${i}`, user: TOKENS }));
test("API-only: a run's account on the listing's 10th page is found (202); one past the 10th page is refused fail closed, 422 under connected_account_id in words naming the page bound; nothing reaches the MCP endpoint", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const within = await setup(t, { fake: { accountsPage: 1, accounts: { gmail: [...fillers(9), { status: "ACTIVE", auth_config: MANAGED, id: TOKENS_ACCOUNT, user: TOKENS }] } } });
  assert.equal((await within.token("PUT", "/settings/mcp-servers/mail/composio", SAVE)).status, 200);
  const found = await runAs(within.token, { composio_user_id: TOKENS, connected_account_id: TOKENS_ACCOUNT });
  assert.equal(found.status, 202, JSON.stringify(found.body));

  const past = await setup(t, { fake: { accountsPage: 1, accounts: { gmail: [...fillers(10), { status: "ACTIVE", auth_config: MANAGED, id: TOKENS_ACCOUNT, user: TOKENS }] } } });
  assert.equal((await past.token("PUT", "/settings/mcp-servers/mail/composio", SAVE)).status, 200);
  const before = await runCount(past);
  const binding = { composio_user_id: TOKENS, connected_account_id: TOKENS_ACCOUNT };
  const run = await runAs(past.token, binding);
  assert.equal(run.status, 422, JSON.stringify(run.body));
  assert.deepEqual(run.body.error?.fields?.map((issue) => [issue.field, issue.reason]), [["mcp_auth.mail.connected_account_id", "not_allowed"]]);
  assert.match(run.body.error.fields[0].message, /more than 10 pages.*can't check/, run.body.error.fields[0].message);
  assert.doesNotMatch(run.body.error.fields[0].message, /not listed under/, "its own reason, not the not-listed one");
  assert.equal(await runCount(past), before, "no run made");
  nothingAsBound(past, binding);
});

test("API-only: the token's save doesn't count an ACTIVE account Composio answers under another user (one answering every user's): 200 with a connect link, and its record never holds that account", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { fake: { ignoreUserIds: true, accounts: { gmail: [{ status: "ACTIVE", auth_config: MANAGED, id: OWNERS_ACCOUNT, user: OWNER }] } } });
  const saved = await s.token("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, user_id: "ops" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(typeof saved.body.connect_url, "string", "no ACTIVE account for the token's own user: a connect link");
  assert.equal(JSON.stringify(saved.body).includes(OWNERS_ACCOUNT), false);
  const record = await s.server.store.settings.get(composioMadeKey("mail"));
  assert.equal(JSON.stringify(record).includes(OWNERS_ACCOUNT), false, "the record holds no account of another user");
});

test("full profile: the owner's run of the owner's per-run Composio server is as before: bound to the owner's user and account, it starts (202) and calls as them, with no account lookup", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { full: true });
  const owner = asOwner(s.server);
  assert.equal((await owner("PUT", "/settings/mcp-servers/mail/composio", SAVE)).status, 200);
  const from = s.composio.calls.length;
  const run = await runAs(owner, { composio_user_id: OWNER, connected_account_id: OWNERS_ACCOUNT });
  assert.equal(run.status, 202, JSON.stringify(run.body));
  assert.match(await answerOf(s, run.body.run_id), /The tool said: 5/);
  assert.deepEqual(lookups(s, from), [], "no lookup");
});

/** A claim on an API-only store of a run granted mail's `add`, mail being a Composio server at the fake's MCP origin
 *  (`url`), read with COMPOSIO_API_KEY, saved by the token (`perRun`: one whose runs each name their account; else one
 *  calling as the user its address names), the run's launch sealing `handed` (its mcp_auth) when given. */
async function claimed(t, composio, { url, perRun, handed }) {
  const { store } = await storeOn(t);
  const sealKey = Buffer.alloc(32, 9);
  await store.mcp.put({ name: "mail", url, auth: "headers", tools: [ADD_TOOL], sealed: null });
  const row = await store.mcp.server("mail");
  await store.settings.put(mcpSourceKey("mail"), storedSource({ source: "composio", toolkit: "gmail" }, row, false, true));
  const user = new URL(url).searchParams.get("user_id");
  await store.settings.put(composioMadeKey("mail"), storedMade(perRun ? { user: "per_run", auth_config: { id: MANAGED, made: false }, accounts: [], per_run: true, key_env: KEY_ENV } : { user, auth_config: { id: MANAGED, made: false }, accounts: [], key_env: KEY_ENV }, row));
  await holdApiOnlyMcpOrigins(store, true, []);
  await store.agents.create({ id: "agent-1", name: "a" }, { id: "rev-1", kind: "agentic", body: {}, mcpPin: await registryPin(store) });
  const origin = new URL(url).origin;
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { content: "go" }, title: "go", place: { mode: "runner" } }, sealed: handed ? sealRunMcpAuth(sealKey, "run-1", { mail: { composio: handed, origin } }) : null });
  const claim = await store.claim("run-1", "runner-a", { leaseMs: 600_000 });
  const step = await mcpClaim({ loopback: true, store, claim, grants: ["mcp:mail/add"], sealKey, signal: new AbortController().signal, composioMcpOrigin: composio.mcpOrigin });
  t.after(() => step.release());
  return step;
}

test("claim, API-only: a run's binding sealed outside the token's namespace (before this rule) gets no entry but the refusal's words: its calls are refused unsent; one inside it is handed on", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const composio = await startFakeComposio({ apiKey: KEY, toolkits: { gmail: { no_auth: false, tools: [ADD] } }, ...FAKE });
  t.after(() => composio.close());
  const url = `${composio.mcpOrigin}/v3/mcp/srv_tokens/mcp?include_composio_helper_actions=true`;
  const refused = await claimed(t, composio, { url, perRun: true, handed: { user_id: OWNER, connected_account_id: OWNERS_ACCOUNT } });
  assert.match(refused.credentials.mail?.unopened ?? "", /API token's own.*agentrun\.token\./, JSON.stringify(refused.credentials.mail));
  assert.equal(refused.credentials.mail.query, undefined, "no query: nothing calls as the owner's user");
  assert.equal(JSON.stringify(refused.credentials.mail).includes(OWNER), false, "the words never name the user");
  const handed = await claimed(t, composio, { url, perRun: true, handed: { user_id: TOKENS, connected_account_id: TOKENS_ACCOUNT } });
  assert.equal(handed.credentials.mail?.unopened, undefined, JSON.stringify(handed.credentials.mail));
  assert.equal(handed.credentials.mail.query?.user_id, TOKENS);
});

test("claim, API-only: a Composio server the token saved calling as a user outside its namespace (saved before it) gets no entry but words that say to delete it; one calling as a namespaced user is handed its key", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const composio = await startFakeComposio({ apiKey: KEY, toolkits: { gmail: { no_auth: false, tools: [ADD] } }, ...FAKE });
  t.after(() => composio.close());
  const legacy = await claimed(t, composio, { url: `${composio.mcpOrigin}/v3/mcp/srv_tokens/mcp?user_id=${OWNER}` });
  assert.match(legacy.credentials.mail?.unopened ?? "", /before.*namespace.*[Dd]elete/, JSON.stringify(legacy.credentials.mail));
  assert.equal(legacy.credentials.mail.headers, undefined, "no key handed");
  const own = await claimed(t, composio, { url: `${composio.mcpOrigin}/v3/mcp/srv_tokens/mcp?user_id=${TOKENS}` });
  assert.equal(own.credentials.mail?.headers?.["x-api-key"], KEY, JSON.stringify(own.credentials.mail?.unopened));
});

test("API-only start: one log line names the Composio servers the token saved that call as a user outside its namespace, by name alone; none, no line", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const first = await setup(t);
  assert.equal(first.log.text().includes("api_only_composio_outside_namespace"), false, "none: no line");
  const { store, data } = first.server;
  for (const [name, user] of [["mail", OWNER], ["notes", TOKENS]]) {
    await store.mcp.put({ name, url: `${first.composio.mcpOrigin}/v3/mcp/srv_${name}/mcp?user_id=${user}`, auth: "headers", tools: [ADD_TOOL], sealed: null });
    const row = await store.mcp.server(name);
    await store.settings.put(mcpSourceKey(name), storedSource({ source: "composio", toolkit: "gmail" }, row, false, true));
    await store.settings.put(composioMadeKey(name), storedMade({ user, auth_config: { id: MANAGED, made: false }, accounts: [], key_env: KEY_ENV }, row));
  }
  await first.server.stop();
  const log = serverLog(t);
  await serve(t, { data, faux: FAUX_MCP, apiOnly: true, composioControl: { baseUrl: first.composio.baseUrl }, composioMcpOrigin: first.composio.mcpOrigin });
  const lines = log.text().split("\n").filter((line) => line.includes("event=api_only_composio_outside_namespace"));
  assert.equal(lines.length, 1, log.text());
  assert.match(lines[0], /servers=mail\b/, lines[0]);
  assert.equal(lines[0].includes("notes"), false, "the namespaced one is not named");
  assert.equal(lines[0].includes(OWNER), false, "no user named");
  assert.equal(lines[0].includes(first.composio.mcpOrigin), false, "no address");
});

test("API-only: the token's re-save of a server it saved before the namespace, whose auth config a server the owner saved stands on, is 403 naming that server and saying the old one can only be deleted; its delete works", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t);
  // The owner's server on the managed config, saved before API-only; the token's, on the same config, calling as the bare user.
  const owners = `${s.composio.mcpOrigin}/v3/mcp/srv_owner/mcp?user_id=agentrun`;
  await s.server.store.mcp.put({ name: "gmail-owner", url: owners, auth: "headers", tools: [ADD_TOOL], sealed: null });
  const ownerRow = await s.server.store.mcp.server("gmail-owner");
  await s.server.store.settings.put(mcpSourceKey("gmail-owner"), storedSource({ source: "composio", toolkit: "gmail" }, ownerRow));
  await s.server.store.settings.put(composioMadeKey("gmail-owner"), storedMade({ user: "agentrun", auth_config: { id: MANAGED, made: false }, accounts: [], key_env: KEY_ENV }, ownerRow));
  await s.server.store.mcp.put({ name: "mail", url: `${s.composio.mcpOrigin}/v3/mcp/srv_tokens/mcp?user_id=agentrun`, auth: "headers", tools: [ADD_TOOL], sealed: null });
  const row = await s.server.store.mcp.server("mail");
  await s.server.store.settings.put(mcpSourceKey("mail"), storedSource({ source: "composio", toolkit: "gmail" }, row, false, true));
  await s.server.store.settings.put(composioMadeKey("mail"), storedMade({ user: "agentrun", auth_config: { id: MANAGED, made: false }, accounts: [], key_env: KEY_ENV }, row));
  const again = await s.token("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, user_id: "agentrun" });
  assert.equal(again.status, 403, JSON.stringify(again.body));
  assert.match(again.body.error?.message ?? "", /gmail-owner/, again.body.error?.message);
  assert.match(again.body.error.message, /[Dd]elete/, "the refusal says the old server can only be deleted");
  const gone = await s.token("DELETE", "/settings/mcp-servers/mail");
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
});

test("a Composio save naming a user_id that starts the token's namespace in any letter case is 422 not_allowed under user_id, nothing sent to Composio", async (t) => {
  withEnv(t, { [KEY_ENV]: KEY });
  const s = await setup(t, { full: true });
  const from = s.composio.calls.length;
  for (const user_id of ["Agentrun.Token.ops", "AGENTRUN.TOKEN.ops"]) {
    const res = await asOwner(s.server)("PUT", "/settings/mcp-servers/mail/composio", { ...SAVE, user_id });
    assert.equal(res.status, 422, `${user_id}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(res.body.error?.fields?.map((issue) => [issue.field, issue.reason]), [["user_id", "not_allowed"]]);
  }
  assert.deepEqual(s.composio.calls.slice(from), [], "nothing sent");
});
