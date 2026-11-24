// A per-run Composio server lends the install's Composio key to each run's binding (mcp_auth.<server> =
// {composio_user_id, connected_account_id?}). The owner's own Composio users, the ones the owner's saved preset servers
// call as (and the preset's default user), are the owner's: the API token never binds a run to one. On a start, an
// inline start, a launch hook's host start and a message, a token's binding of one is 422 at
// mcp_auth.<server>.composio_user_id, nothing written. The owner's set is read at each check, so a user the owner
// connects after a token's start is refused at the next. The seal marks who handed each binding (`by`), and the runner's
// claim reads the set again: a token's binding of a user the owner has connected since, or an unmarked one sealed before
// the mark, is refused unsent. The owner's session binds the owner's users as before. API-only has no owner: only the
// default user is refused. Fake Composio on loopback (fixtures/fake-composio.mjs), the faux MCP model
// (fixtures/faux-mcp.mjs). No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { agent, asOwner, follow, secretWritePath, serve, startInProcessRunner, whenFree, withEnv } from "./support.mjs";
import { fakeClock, firings, hookServer, made, schedule } from "./trigger-support.mjs";

const { COMPOSIO_USER } = await import("../dist/composio-preset.js");
const { openRunLaunch, sealRunLaunch } = await import("../dist/store/index.js");
const { uuidv7 } = await import("../dist/ids.js");
const { mintSecret } = await import("../dist/standard-webhooks.js");

secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const ADD = { slug: "add", name: "Add", description: "Add two numbers." };
const TOOLKITS = { gmail: { no_auth: false, tools: [ADD] } };
const USER_A = "host-user-alice-0001";
const ACCOUNT_A = "ca_alice_gmail_0001";
const USER_B = "host-user-bob-0002";
const ACCOUNT_B = "ca_bob_gmail_0002";
const OWNER = "owner-0001";
const ACCOUNT_OWNER = "ca_owner_gmail_0001";
const TOKEN_USER = "agentrun.token.ops";
const MCP_ACCOUNTS = { [USER_A]: [ACCOUNT_A], [USER_B]: [ACCOUNT_B], [OWNER]: [ACCOUNT_OWNER], [TOKEN_USER]: ["ca_token_gmail_0003"], [COMPOSIO_USER]: ["ca_shared_gmail_0001"] };
const CALL = 'Call mcp__mail__add with {"a":2,"b":3}';
const bind = (user, account) => ({ mail: { composio_user_id: user, ...(account ? { connected_account_id: account } : {}) } });
const FIELD = "mcp_auth.mail.composio_user_id";
// What a run whose call was refused at its claim says, its server named (mcp-gateway.ts).
const REFUSED_AT_CLAIM = "The MCP server mail's credential can't be used right now:";
const inline = (mcp_auth) => ({
  external: { source: "backend", kind: "expert", id: "mail-reader", version: 1 },
  definition: { name: "Expert mail-reader", instructions: "Answer.", skills: [], tools: ["mcp:mail/add"], tool_settings: { "mcp:mail/add": { permission: "allow" } }, harness: "pi" },
  input: { content: CALL },
  mcp_auth,
});

/** A server (`serveOptions` over the defaults) with the per-run Gmail server `mail` saved by the owner and an agent
 *  `reader` allowed its `add`. `token` sends with the API token, `owner` from the owner's session. */
async function setup(t, serveOptions = {}) {
  const composio = await startFakeComposio({ toolkits: TOOLKITS, mcpAccounts: MCP_ACCOUNTS });
  t.after(() => composio.close());
  const options = { faux: FAUX_MCP, composioControl: { baseUrl: composio.baseUrl }, publicUrl: "https://agentrun.example.com", ...serveOptions };
  const server = await serve(t, options);
  const token = (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${server.token}` });
  const owner = asOwner(server);
  const saved = await owner("PUT", "/settings/mcp-servers/mail/composio", { api_key: composio.apiKey, toolkit: "gmail", tools: ["add"], user_id: "per_run" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const reader = await whenFree(() => owner("POST", "/agents", agent("reader", { tools: ["mcp:mail/add"], tool_settings: { "mcp:mail/add": { permission: "allow" } } })));
  assert.equal(reader.status, 201, JSON.stringify(reader.body));
  /** The owner connects `user`: a preset server `name` saved for that one user. */
  const connects = async (user, name = "inbox") => {
    const own = await owner("PUT", `/settings/mcp-servers/${name}/composio`, { api_key: composio.apiKey, toolkit: "gmail", tools: ["add"], user_id: user });
    assert.equal(own.status, 200, `the owner saves ${name} for one user: ${JSON.stringify(own.body)}`);
  };
  /** A runner of this test's own beside a server started with `runner: false`, once the test has set the store up. */
  const runner = async () => {
    const close = await startInProcessRunner(server.data, { ...options, mcpOwn: server.own });
    let closed;
    const halt = () => (closed ??= close());
    t.after(halt);
    return halt;
  };
  const runCount = async () => (await token("GET", "/runs")).body.runs.length;
  return { composio, server, store: server.store, token, owner, connects, runner, runCount };
}

/** The 422 a token's binding of an owner's user gets: at the user's field, not_allowed, in words that say the owner
 *  connects it here, never echoing what was sent. */
function refusedAsOwners(res, what) {
  const issue = res.body.error?.fields?.[0];
  assert.deepEqual([res.status, res.body.error?.code, issue?.field, issue?.reason], [422, "input_invalid", FIELD, "not_allowed"], `${what}: ${JSON.stringify(res.body)}`);
  assert.match(issue.message, /owner connects/, `${what}: the words say the owner connects that user here`);
  for (const value of [OWNER, ACCOUNT_OWNER]) assert.equal(JSON.stringify(res.body).includes(value), false, `${what}: the refusal never echoes ${value}`);
}

const toolCalls = (log) => log.filter((entry) => entry.method === "tools/call");
const asWho = (entry) => {
  const query = new URL(entry.path, "http://composio.test").searchParams;
  return [query.get("user_id"), query.get("connected_account_id")];
};
/** Run `id` followed to its end: its answer. */
async function ended(s, id) {
  await follow(s.token, id, ["completed", "failed"], { deadlineMs: 60_000 });
  return String((await s.token("GET", `/runs/${id}`)).body.result?.final_answer ?? "");
}
const sealKey = (t) => {
  const key = randomBytes(32);
  withEnv(t, { AGENTRUN_SEAL_KEY: key.toString("base64") });
  return key;
};

test("R1 start: a token's start binding a user the owner connected is 422 at the user's field, and no run is written", async (t) => {
  const s = await setup(t);
  await s.connects(OWNER);
  const before = await s.runCount();
  refusedAsOwners(await s.token("POST", "/agents/reader/runs", { input: { content: CALL }, mcp_auth: bind(OWNER, ACCOUNT_OWNER) }), "a token's start binding the owner's user");
  assert.equal(await s.runCount(), before, "no run written");
});

test("R2 inline start: a token's POST /runs binding a user the owner connected is 422 at the user's field, and no run is written", async (t) => {
  const s = await setup(t);
  await s.connects(OWNER);
  const before = await s.runCount();
  refusedAsOwners(await s.token("POST", "/runs", inline(bind(OWNER, ACCOUNT_OWNER))), "a token's inline start binding the owner's user");
  assert.equal(await s.runCount(), before, "no run written");
});

test("R3 message: a token's message binding a user the owner connected is 422 at the user's field, and the run's seal keeps its earlier binding", async (t) => {
  const key = sealKey(t);
  const s = await setup(t, { runner: false });
  await s.connects(OWNER);
  // No runner: the run stays queued, its binding sealed in its launch.
  const started = await s.token("POST", "/agents/reader/runs", { input: { content: CALL }, mcp_auth: bind(USER_A, ACCOUNT_A) });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const id = started.body.run_id;
  refusedAsOwners(await s.token("POST", `/runs/${id}/messages`, { content: CALL, mcp_auth: bind(OWNER, ACCOUNT_OWNER) }), "a token's message binding the owner's user");
  const held = openRunLaunch(key, id, (await s.store.runs.launch(id)).sealed)?.mcp?.mail?.composio;
  assert.deepEqual([held?.user_id, held?.connected_account_id], [USER_A, ACCOUNT_A], "the run's seal opens to its earlier binding");
});

test("R4 launch-hook firing: a token host start with trigger_firing binding a user the owner connected is 422; no run exists for the firing, which stays as it was", { timeout: 120_000 }, async (t) => {
  const clock = fakeClock("2026-06-01T00:00:00Z");
  const hook = await hookServer(t);
  const s = await setup(t, { runner: false, triggerClock: clock, launchHook: { url: hook.url, secret: mintSecret() } });
  await s.connects(OWNER);
  await made(s.token, "nightly");
  const created = await s.owner("POST", "/triggers", schedule("nightly", { every_s: 600, start_at: "2026-06-01T00:10:00Z" }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  clock.to("2026-06-01T00:10:00Z");
  const [handed] = await firings(s.token, created.body.id, 1);
  assert.deepEqual([handed.status, handed.run_id], ["sent", null], "the host answered first, with no run yet");
  const ref = { trigger_id: created.body.id, firing_id: handed.key };
  refusedAsOwners(await s.token("POST", "/agents/nightly/runs", { input: { content: "Say hello." }, max_cost_usd: 0.5, trigger_firing: ref, mcp_auth: bind(OWNER, ACCOUNT_OWNER) }), "a token host's firing start binding the owner's user");
  assert.deepEqual((await s.token("GET", "/runs?agent=nightly")).body.runs, [], "no run for the firing");
  const [still] = (await s.token("GET", `/triggers/${created.body.id}/firings`)).body.firings;
  assert.deepEqual([still.key, still.status, still.run_id, still.start_by], [handed.key, "sent", null, handed.start_by], "the firing stays sent, its window as it was");
  // The same start binding a user the owner hasn't connected is the firing's run.
  const other = await s.token("POST", "/agents/nightly/runs", { input: { content: "Say hello." }, max_cost_usd: 0.5, trigger_firing: ref, mcp_auth: bind(USER_A, ACCOUNT_A) });
  assert.equal(other.status, 202, `a binding of a user the owner hasn't connected starts the firing's run: ${JSON.stringify(other.body)}`);
  const [now] = (await s.token("GET", `/triggers/${created.body.id}/firings`)).body.firings;
  assert.deepEqual([now.status, now.run_id], ["started", other.body.run_id]);
});

test("R5 default user (a guard): a token's start binding the preset's default user, with no owner server saved, is 422 at the user's field", async (t) => {
  const s = await setup(t);
  const before = await s.runCount();
  const res = await s.token("POST", "/agents/reader/runs", { input: { content: CALL }, mcp_auth: bind(COMPOSIO_USER) });
  const issue = res.body.error?.fields?.[0];
  assert.deepEqual([res.status, issue?.field, issue?.reason], [422, FIELD, "not_allowed"], JSON.stringify(res.body));
  assert.equal(await s.runCount(), before, "no run written");
});

test("R6 read at each check: a token's start binding U passes; once the owner saves a Composio server for U, the next token start binding U is 422", async (t) => {
  const s = await setup(t);
  const first = await s.token("POST", "/agents/reader/runs", { input: { content: CALL }, mcp_auth: bind(OWNER, ACCOUNT_OWNER) });
  assert.equal(first.status, 202, `before the owner connects U, a token binds it: ${JSON.stringify(first.body)}`);
  await ended(s, first.body.run_id);
  await s.connects(OWNER);
  refusedAsOwners(await s.token("POST", "/agents/reader/runs", { input: { content: CALL }, mcp_auth: bind(OWNER, ACCOUNT_OWNER) }), "a token's start binding U once the owner connected it");
});

test("R7 use: a token run sealed a binding for U, the owner then connects U, and at the run's claim its call is refused unsent in words that say how to clear it", { timeout: 120_000 }, async (t) => {
  sealKey(t);
  const s = await setup(t, { runner: false });
  const started = await s.token("POST", "/agents/reader/runs", { input: { content: CALL }, mcp_auth: bind(OWNER, ACCOUNT_OWNER) });
  assert.equal(started.status, 202, `before the owner connects U, a token binds it: ${JSON.stringify(started.body)}`);
  await s.connects(OWNER);
  const from = s.composio.mcpLog.length;
  const halt = await s.runner();
  const answer = await ended(s, started.body.run_id);
  await halt();
  assert.deepEqual(toolCalls(s.composio.mcpLog.slice(from)).map(asWho), [], `nothing sent to Composio: ${answer}`);
  assert.ok(answer.includes(REFUSED_AT_CLAIM), `refused at the claim, naming the server: ${answer}`);
  assert.match(answer, /owner connects/, "the words say the owner connects that user");
  assert.match(answer, /hand mcp_auth again on a message, or start a new run/, "the words say how to clear it");
});

test("R8 unmarked seal: a run whose seal holds a binding in the shape before the mark, for a user the owner connected, is refused unsent at its claim in the same words", { timeout: 120_000 }, async (t) => {
  const key = sealKey(t);
  const s = await setup(t, { runner: false });
  await s.connects(OWNER);
  // A queued run of `reader` with no binding, whose launch the run sealed in the old shape copies.
  const template = await s.token("POST", "/agents/reader/runs", { input: { content: CALL } });
  assert.equal(template.status, 202, JSON.stringify(template.body));
  const row = await s.store.runs.get(template.body.run_id);
  const launch = await s.store.runs.launch(template.body.run_id);
  const origin = new URL((await s.store.mcp.server("mail")).url).origin;
  const id = uuidv7();
  await s.store.runs.create({ id, agentId: "reader", revisionId: row.revisionId }, { body: launch.body, sealed: sealRunLaunch(key, id, { mcp: { mail: { composio: { user_id: OWNER, connected_account_id: ACCOUNT_OWNER }, origin } } }) });
  const from = s.composio.mcpLog.length;
  const halt = await s.runner();
  const answer = await ended(s, id);
  await ended(s, template.body.run_id);
  await halt();
  assert.deepEqual(toolCalls(s.composio.mcpLog.slice(from)).map(asWho), [], `nothing sent to Composio: ${answer}`);
  assert.ok(answer.includes(REFUSED_AT_CLAIM), `refused at the claim, naming the server: ${answer}`);
  assert.match(answer, /owner connects/, "the words say the owner connects that user");
  assert.match(answer, /hand mcp_auth again on a message, or start a new run/, "the words say how to clear it");
});

test("a token binding a user the owner hasn't connected passes on a start, an inline start and a message, and its call reaches Composio as that user", { timeout: 120_000 }, async (t) => {
  const s = await setup(t);
  await s.connects(OWNER);
  const started = await s.token("POST", "/agents/reader/runs", { input: { content: CALL }, mcp_auth: bind(USER_A, ACCOUNT_A) });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const from = s.composio.mcpLog.length;
  assert.match(await ended(s, started.body.run_id), /The tool said: 5/);
  assert.deepEqual(toolCalls(s.composio.mcpLog.slice(from)).map(asWho), [[USER_A, ACCOUNT_A]], "as its user and account");
  const messaged = await s.token("POST", `/runs/${started.body.run_id}/messages`, { content: CALL, mcp_auth: bind(USER_B, ACCOUNT_B) });
  assert.equal(messaged.status, 202, JSON.stringify(messaged.body));
  const inlined = await s.token("POST", "/runs", inline(bind(USER_A, ACCOUNT_A)));
  assert.equal(inlined.status, 202, JSON.stringify(inlined.body));
  const token = await s.token("POST", "/agents/reader/runs", { input: { content: CALL }, mcp_auth: bind(TOKEN_USER) });
  assert.equal(token.status, 202, `a token's own user (${TOKEN_USER}) binds: ${JSON.stringify(token.body)}`);
});

test("the owner's session binds a user the owner connected: its start passes, and its claim calls Composio as that user", { timeout: 120_000 }, async (t) => {
  const s = await setup(t);
  await s.connects(OWNER);
  const started = await s.owner("POST", "/agents/reader/runs", { input: { content: CALL }, mcp_auth: bind(OWNER, ACCOUNT_OWNER) });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const from = s.composio.mcpLog.length;
  const answer = await ended(s, started.body.run_id);
  assert.match(answer, /The tool said: 5/, answer);
  assert.deepEqual(toolCalls(s.composio.mcpLog.slice(from)).map(asWho), [[OWNER, ACCOUNT_OWNER]], "as the owner's user and account");
});

test("API-only: no owner, so a token binds a bare user id and agentrun.token.<x>, and its call reaches Composio as that user", { timeout: 120_000 }, async (t) => {
  const KEY = `not-a-secret-${"composio-env-key-0001"}`;
  withEnv(t, { COMPOSIO_API_KEY: KEY });
  const composio = await startFakeComposio({ apiKey: KEY, toolkits: TOOLKITS, mcpAccounts: MCP_ACCOUNTS });
  t.after(() => composio.close());
  const server = await serve(t, { faux: FAUX_MCP, composioControl: { baseUrl: composio.baseUrl }, composioMcpOrigin: composio.mcpOrigin, apiOnly: true });
  const token = (method, path, body) => server.api(method, path, body, { authorization: `Bearer ${server.token}` });
  const saved = await token("PUT", "/settings/mcp-servers/mail/composio", { api_key_env: "COMPOSIO_API_KEY", toolkit: "gmail", tools: ["add"], user_id: "per_run" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  for (const [user, account] of [[USER_A, ACCOUNT_A], [TOKEN_USER]]) {
    const from = composio.mcpLog.length;
    const started = await token("POST", "/runs", inline(bind(user, account)));
    assert.equal(started.status, 202, `${user}: ${JSON.stringify(started.body)}`);
    await follow(token, started.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
    assert.deepEqual(toolCalls(composio.mcpLog.slice(from)).map((entry) => asWho(entry)[0]), [user], `${user}'s call reached Composio as that user`);
  }
});
