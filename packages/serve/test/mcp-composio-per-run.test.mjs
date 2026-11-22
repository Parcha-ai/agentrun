// A per-run Composio server: the Composio preset saved with `user_id: "per_run"` keeps no Composio user and no connected
// account in its address, and each run binds it to one (`mcp_auth.<server> = {composio_user_id, connected_account_id?}`
// on POST /runs, POST /agents/{id}/runs and POST /runs/{id}/messages). The runner's claim calls Composio's MCP endpoint as
// that user and account for that run alone; a run bound to none is refused before anything is sent, in the per_run
// missing-credential words; the binding is in no row, answer, span or log line, and the run's end erases it. A server saved
// for one user behaves as before. Composio's MCP endpoint refuses an address that names no user, its listing too (probed
// live 2026-11-19), so the server's save, refresh, preview and an agent's save list its tools as a listing-only user no
// binding can name. Fake Composio on loopback (fixtures/fake-composio.mjs, which refuses as Composio does), the faux MCP
// model (fixtures/faux-mcp.mjs). No key, no network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFakeComposio } from "./fixtures/fake-composio.mjs";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, follow, secretWritePath, serve, serverLog, storeBytes, whenFree } from "./support.mjs";

const { UNUSABLE } = await import("../dist/mcp-probe.js");
const { COMPOSIO_LISTING_USER, COMPOSIO_USER, COMPOSIO_USER_ID } = await import("../dist/composio-preset.js");
const { composioMadeKey } = await import("../dist/composio-made.js");
const { ISSUE_ADDED } = await import("./fixtures/fake-composio.mjs");

secretWritePath(["PUT"], /^\/settings\/mcp-servers\/[^/]+\/composio$/);

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
// The fake Composio's MCP endpoint serves the fake MCP server's tools (fake-mcp-server.mjs): `add` stands in for Gmail's
// inbox read, a call that answers the account it runs as.
const ADD = { slug: "add", name: "Add", description: "Add two numbers." };
const TOOLKITS = { gmail: { no_auth: false, tools: [ADD] } };
const USER_A = "grep-user-alice-0001";
const ACCOUNT_A = "ca_alice_gmail_0001";
const USER_B = "grep-user-bob-0002";
const ACCOUNT_B = "ca_bob_gmail_0002";
const OWNER = "owner-0001";
// A team's connected account, as grep names it: Composio user `team:<tenant>` (agent_connections/registry.py TEAM_SCOPE_PREFIX).
const TEAM = "team:tenant-0042";
const ACCOUNT_TEAM = "ca_team_gmail_0042";
// Each Composio user's connected accounts, as the fake's MCP endpoint checks a call against them.
// The preset's default user (`agentrun`) has its own account too: the one a single-user preset server calls as.
const MCP_ACCOUNTS = { [USER_A]: [ACCOUNT_A], [USER_B]: [ACCOUNT_B], [OWNER]: ["ca_owner_gmail_0001"], [TEAM]: [ACCOUNT_TEAM], [COMPOSIO_USER]: ["ca_shared_gmail_0001"] };
const CALL = 'Call mcp__mail__add with {"a":2,"b":3}';
const bind = (user, account) => ({ mail: { composio_user_id: user, ...(account ? { connected_account_id: account } : {}) } });

/** A server with the per-run Gmail server `mail` saved through the preset and an agent `reader` allowed its `add`. */
async function setup(t) {
  const composio = await startFakeComposio({ toolkits: TOOLKITS, mcpAccounts: MCP_ACCOUNTS });
  t.after(() => composio.close());
  const log = serverLog(t);
  const server = await serve(t, { faux: FAUX_MCP, composioControl: { baseUrl: composio.baseUrl }, publicUrl: "https://agentrun.example.com" });
  const saved = await server.api("PUT", "/settings/mcp-servers/mail/composio", { api_key: composio.apiKey, toolkit: "gmail", tools: ["add"], user_id: "per_run" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const made = await whenFree(() => server.api("POST", "/agents", agent("reader", { tools: ["mcp:mail/add"], tool_settings: { "mcp:mail/add": { permission: "allow" } } })));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return { composio, log, server, api: server.api, saved: saved.body };
}

/** `reader` run once to its end with `mcp_auth` (none: unbound): its id, view and answer, and the requests the fake
 *  Composio's MCP endpoint got meanwhile, each with the query it was sent at. */
async function runOnce(s, mcp_auth, { agentId = "reader", content = CALL } = {}) {
  const from = s.composio.mcpLog.length;
  const started = await whenFree(() => s.api("POST", `/agents/${agentId}/runs`, { input: { content }, ...(mcp_auth ? { mcp_auth } : {}) }));
  assert.equal(started.status, 202, `the run starts with its binding: ${JSON.stringify(started.body)}`);
  const id = started.body.run_id;
  await follow(s.api, id, ["completed", "failed"], { deadlineMs: 60_000 });
  const view = (await s.api("GET", `/runs/${id}`)).body;
  const sent = s.composio.mcpLog.slice(from).map((entry) => ({ ...entry, query: new URL(entry.path, "http://composio.test").searchParams }));
  return { id, view, answer: String(view.result?.final_answer ?? ""), sent };
}
const toolCalls = (sent) => sent.filter((entry) => entry.method === "tools/call");
/** The user and account a request was sent as, by its address. */
const asWho = (entry) => [entry.query.get("user_id"), entry.query.get("connected_account_id")];

test("two users, one per-run Gmail server: B's run is called at Composio as B's user and account and never A's, and A's run the converse", async (t) => {
  const s = await setup(t);
  const a = await runOnce(s, bind(USER_A, ACCOUNT_A));
  const b = await runOnce(s, bind(USER_B, ACCOUNT_B));
  for (const [run, mine, theirs, who] of [[a, [USER_A, ACCOUNT_A], [USER_B, ACCOUNT_B], "A"], [b, [USER_B, ACCOUNT_B], [USER_A, ACCOUNT_A], "B"]]) {
    assert.equal(toolCalls(run.sent).length, 1, `${who}'s one call reached Composio: ${run.answer}`);
    assert.match(run.answer, /The tool said: 5/, `${who}'s call answered`);
    assert.deepEqual(run.sent.map(asWho), run.sent.map(() => mine), `every request of ${who}'s run is as ${who}'s user and account`);
    assert.deepEqual(run.sent.filter((entry) => theirs.some((value) => entry.path.includes(value))), [], `none of ${who}'s run's requests names the other user or account`);
  }
});

test("a team's account binds a run as a person's does: its Composio user team:<tenant> is taken, and the run calls as that user and account; a space, a slash or the listing-only user's ~ is still refused", async (t) => {
  const s = await setup(t);
  const team = await runOnce(s, bind(TEAM, ACCOUNT_TEAM));
  assert.equal(toolCalls(team.sent).length, 1, `the team's one call reached Composio: ${team.answer}`);
  assert.match(team.answer, /The tool said: 5/, "the team's call answered");
  assert.deepEqual(team.sent.map(asWho), team.sent.map(() => [TEAM, ACCOUNT_TEAM]), "every request is as the team's user and account");
  for (const user of ["team:has space", "team:a/b", COMPOSIO_LISTING_USER]) {
    const refused = await s.api("POST", "/agents/reader/runs", { input: { content: "Hi" }, mcp_auth: bind(user, ACCOUNT_TEAM) });
    assert.deepEqual([refused.status, refused.body.error?.fields?.[0]?.field, refused.body.error?.fields?.[0]?.reason], [422, "mcp_auth.mail.composio_user_id", "invalid"], `${user}: ${JSON.stringify(refused.body)}`);
  }
});

test("an unbound run of a per-run server is refused before any request, in UNUSABLE.perRunMissing's words; a bound run beside it reaches Composio", async (t) => {
  const s = await setup(t);
  const unbound = await runOnce(s);
  assert.deepEqual(unbound.sent.map((entry) => `${entry.http} ${entry.path} ${entry.method ?? ""}`), [], "Composio's MCP endpoint got nothing from the unbound run");
  assert.ok(unbound.answer.includes(UNUSABLE.perRunMissing), `refused in the per_run missing words: ${unbound.answer}`);
  const bound = await runOnce(s, bind(USER_A));
  assert.equal(toolCalls(bound.sent).length, 1, `the bound run's call reached Composio: ${bound.answer}`);
  assert.deepEqual(bound.sent.map(asWho), bound.sent.map(() => [USER_A, null]), "as its user, with no account named when the binding names none");
});

test("the binding never leaks: after a bound run ends, the server row, the store's bytes, the run's read, timeline and trace, and the log hold neither the user nor the account", async (t) => {
  const s = await setup(t);
  const run = await runOnce(s, bind(USER_A, ACCOUNT_A));
  assert.equal(toolCalls(run.sent).length, 1, `the call reached Composio: ${run.answer}`);
  assert.deepEqual(asWho(toolCalls(run.sent)[0]), [USER_A, ACCOUNT_A], "as the run's user and account");
  assert.equal((await s.server.store.runs.launch(run.id)).sealed, null, "the run's end erased its binding from its launch");
  const row = await s.server.store.mcp.server("mail");
  assert.equal(new URL(row.url).searchParams.has("user_id"), false, "the server's address names no user");
  const answers = JSON.stringify([
    row,
    s.saved,
    (await s.api("GET", "/settings/mcp-servers/mail")).body,
    run.view,
    (await s.api("GET", "/runs")).body,
    (await s.api("GET", `/runs/${run.id}/timeline`)).body,
    (await s.api("GET", `/runs/${run.id}/trace`)).body,
  ]);
  await s.server.store.flush();
  const bytes = storeBytes(s.server.data);
  for (const value of [USER_A, ACCOUNT_A]) {
    assert.equal(answers.includes(value), false, `no row or answer holds ${value}`);
    assert.equal(bytes.includes(Buffer.from(value)), false, `the store's bytes hold no ${value} in the clear`);
    assert.equal(s.log.text().includes(value), false, `no log line holds ${value}`);
  }
});

test("bindings are checked: a well-formed one starts the run; a bad user, an account not shaped as Composio's, headers for a per-run Composio server, or a binding for any other server is 422 naming the field, no run made", async (t) => {
  const s = await setup(t);
  const asToken = { authorization: `Bearer ${s.server.token}` };
  const good = await s.api("POST", "/agents/reader/runs", { input: { content: "Hi" }, mcp_auth: bind(USER_A, ACCOUNT_A) }, asToken);
  assert.equal(good.status, 202, `a well-formed binding starts the run, from the API token: ${JSON.stringify(good.body)}`);
  await follow(s.api, good.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  // The shortest account id taken is 8 characters, so the run's redactors (which hold a value of 8 or more) hold every one.
  const shortest = await s.api("POST", "/agents/reader/runs", { input: { content: "Hi" }, mcp_auth: bind(USER_A, "ca_abcde") }, asToken);
  assert.equal(shortest.status, 202, `an 8-character account id starts the run: ${JSON.stringify(shortest.body)}`);
  await follow(s.api, shortest.body.run_id, ["completed", "failed"], { deadlineMs: 60_000 });
  const before = (await s.api("GET", "/runs")).body.runs.length;
  // A per_run server that takes headers from each run: a binding is for a per-run Composio server alone.
  const gateway = await startFakeMcp();
  t.after(() => gateway.close());
  const gw = await s.api("PUT", "/settings/mcp-servers/gw", { url: gateway.url, auth: { type: "per_run" } }, asToken);
  assert.equal(gw.status, 200, JSON.stringify(gw.body));
  for (const [mcp_auth, field, reason] of [
    [{ gw: { composio_user_id: USER_A } }, "mcp_auth.gw", "not_an_option"],
    [bind("", ACCOUNT_A), "mcp_auth.mail.composio_user_id", "invalid"],
    [bind("x".repeat(129)), "mcp_auth.mail.composio_user_id", "invalid"],
    [bind("has space"), "mcp_auth.mail.composio_user_id", "invalid"],
    [bind(USER_A, "acct-1"), "mcp_auth.mail.connected_account_id", "invalid"],
    [bind(USER_A, "ca_abcd"), "mcp_auth.mail.connected_account_id", "invalid"],
    [bind(USER_A, `ca_${"x".repeat(200)}`), "mcp_auth.mail.connected_account_id", "invalid"],
    [{ mail: { headers: { authorization: "Bearer x" } } }, "mcp_auth.mail", "not_an_option"],
    [{ mail: { composio_user_id: USER_A, headers: { authorization: "Bearer x" } } }, "mcp_auth.mail.headers", "not_allowed"],
  ]) {
    const refused = await s.api("POST", "/agents/reader/runs", { input: { content: "Hi" }, mcp_auth });
    assert.deepEqual([refused.status, refused.body.error?.code, refused.body.error?.fields?.[0]?.field, refused.body.error?.fields?.[0]?.reason], [422, "input_invalid", field, reason], `${JSON.stringify(mcp_auth).slice(0, 80)}: ${JSON.stringify(refused.body)}`);
    for (const value of [USER_A, ACCOUNT_A]) assert.equal(JSON.stringify(refused.body).includes(value), false, "a refusal never quotes the binding");
  }
  assert.equal((await s.api("GET", "/runs")).body.runs.length, before, "no run made");
});

test("a binding to the preset's default user is 422 on a run's start and on a message, nothing sent; a binding to another user calls as that user", async (t) => {
  const s = await setup(t);
  const bound = await runOnce(s, bind(USER_A, ACCOUNT_A));
  assert.equal(toolCalls(bound.sent).length, 1, `a binding to another user reaches Composio: ${bound.answer}`);
  assert.deepEqual(bound.sent.map(asWho), bound.sent.map(() => [USER_A, ACCOUNT_A]), "as that user and account");
  const before = (await s.api("GET", "/runs")).body.runs.length;
  const from = s.composio.mcpLog.length;
  const expect = (refused, what) => {
    const issue = refused.body.error?.fields?.[0];
    assert.deepEqual([refused.status, refused.body.error?.code, issue?.field, issue?.reason], [422, "input_invalid", "mcp_auth.mail.composio_user_id", "not_allowed"], `${what} binding the preset's default user ${COMPOSIO_USER} is refused: ${JSON.stringify(refused.body)}`);
    assert.match(issue.message, /shared default/, "the refusal says it is the preset's shared default user");
  };
  for (const mcp_auth of [bind(COMPOSIO_USER), bind(COMPOSIO_USER, "ca_shared_gmail_0001")]) {
    expect(await s.api("POST", "/agents/reader/runs", { input: { content: CALL }, mcp_auth }), "a run's start");
    expect(await s.api("POST", `/runs/${bound.id}/messages`, { content: CALL, mcp_auth }), "a message");
  }
  assert.equal((await s.api("GET", "/runs")).body.runs.length, before, "no run made");
  assert.equal(toolCalls(s.composio.mcpLog.slice(from)).length, 0, "nothing sent to Composio");
});

test("a message's binding replaces the run's: the turn it starts calls Composio as the new user, never the old one", async (t) => {
  const s = await setup(t);
  const first = await runOnce(s, bind(USER_A, ACCOUNT_A));
  assert.equal(toolCalls(first.sent).length, 1, first.answer);
  const from = s.composio.mcpLog.length;
  const sent = await s.api("POST", `/runs/${first.id}/messages`, { content: 'Call mcp__mail__add with {"a":1,"b":1}', mcp_auth: bind(USER_B, ACCOUNT_B) });
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await follow(s.api, first.id, ["completed", "failed"], { after: 0, deadlineMs: 60_000 });
  const later = s.composio.mcpLog.slice(from).map((entry) => ({ ...entry, query: new URL(entry.path, "http://composio.test").searchParams }));
  assert.equal(toolCalls(later).length, 1, "the message's call reached Composio");
  assert.deepEqual(later.map(asWho), later.map(() => [USER_B, ACCOUNT_B]), "every request of the message's turn is as the new binding");
});

test("a per-run Composio server makes no Composio trigger: a trigger runs as one account, and this server has none", async (t) => {
  const s = await setup(t);
  const refused = await s.api("POST", "/triggers", { name: "mail in", source: { kind: "composio", server: "mail", event: "GMAIL_NEW_GMAIL_MESSAGE", config: {} }, target: { kind: "start_run", agent_id: "reader", input: { content: "Read it." }, max_cost_usd: 0.5 } });
  assert.deepEqual([refused.status, refused.body.error?.fields?.[0]?.field], [422, "source.server"], JSON.stringify(refused.body));
  assert.match(refused.body.error.fields[0].message, /per.run|each run/i);
  assert.equal(s.composio.to("/api/v3/trigger_instances").length, 0, "nothing made at Composio");
});

test("the save keeps no account: no user and no connected account in the stored address, no account looked up and no connect link made", async (t) => {
  const s = await setup(t);
  const row = await s.server.store.mcp.server("mail");
  const url = new URL(row.url);
  assert.deepEqual([url.pathname, url.searchParams.has("user_id"), url.searchParams.has("connected_account_id")], [`/v3/mcp/${s.composio.mcpId}/mcp`, false, false], row.url);
  assert.equal(s.saved.connect_url, undefined, "no connect link");
  assert.equal(s.composio.to("/api/v3/connected_accounts").length + s.composio.to("/api/v3/connected_accounts/link").length, 0, "no account asked for or started at Composio");
  assert.deepEqual(row.auth, "headers", "the install's key stays a sealed header");
});

test("a preset server saved for one user is unchanged: its address names that user, its runs call as it with no mcp_auth, and a binding for it is refused", async (t) => {
  const s = await setup(t);
  const saved = await s.api("PUT", "/settings/mcp-servers/inbox/composio", { api_key: s.composio.apiKey, toolkit: "gmail", tools: ["add"], user_id: OWNER });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const url = new URL((await s.server.store.mcp.server("inbox")).url);
  assert.deepEqual([url.searchParams.get("user_id"), url.searchParams.has("connected_account_id")], [OWNER, false], "its address names its user, as before");
  const made = await whenFree(() => s.api("POST", "/agents", agent("own-reader", { tools: ["mcp:inbox/add"], tool_settings: { "mcp:inbox/add": { permission: "allow" } } })));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const run = await runOnce(s, undefined, { agentId: "own-reader", content: 'Call mcp__inbox__add with {"a":2,"b":3}' });
  assert.equal(toolCalls(run.sent).length, 1, run.answer);
  assert.deepEqual(run.sent.map(asWho), run.sent.map(() => [OWNER, null]), "every request as its saved user");
  const refused = await s.api("POST", "/agents/own-reader/runs", { input: { content: "Hi" }, mcp_auth: { inbox: { composio_user_id: USER_A } } });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.ok(String(refused.body.error?.fields?.[0]?.field).startsWith("mcp_auth.inbox"), JSON.stringify(refused.body));
});

test("Composio refuses an address that names no user, so a per-run server's save, refresh, preview and an agent's save list its tools as a listing-only user no binding can name, and call nothing", async (t) => {
  const s = await setup(t);
  assert.ok(s.saved.server?.tools?.some((tool) => tool.name === "add"), `the save listed its tools: ${JSON.stringify(s.saved)}`);
  const refreshed = await s.api("POST", "/settings/mcp-servers/mail/refresh");
  assert.equal(refreshed.status, 200, `the refresh listed its tools: ${JSON.stringify(refreshed.body)}`);
  const previewed = await s.api("POST", "/settings/mcp-servers/preview", { name: "mail" });
  assert.equal(previewed.status, 200, `the preview by name listed its tools: ${JSON.stringify(previewed.body)}`);
  const listings = s.composio.mcpLog.map((entry) => ({ ...entry, query: new URL(entry.path, "http://composio.test").searchParams }));
  assert.ok(listings.some((entry) => entry.method === "tools/list"), "its tools were listed at Composio");
  assert.deepEqual(toolCalls(listings), [], "a listing calls no tool");
  const users = [...new Set(listings.map((entry) => entry.query.get("user_id")))];
  assert.equal(users.length, 1, `every listing names one user: ${users}`);
  assert.ok(users[0] && !COMPOSIO_USER_ID.test(users[0]), `a user no binding (nor a save) can name: ${users[0]}`);
  assert.deepEqual(listings.filter((entry) => entry.query.has("connected_account_id")), [], "and no account");
  assert.equal(new URL((await s.server.store.mcp.server("mail")).url).searchParams.has("user_id"), false, "the stored address still names no user");
});

test("a binding naming another user's account, or a user with no account, gets Composio's refusal and none of the account's data", async (t) => {
  const s = await setup(t);
  const crossed = await runOnce(s, bind(USER_B, ACCOUNT_A));
  assert.equal(toolCalls(crossed.sent).length, 1, crossed.answer);
  assert.deepEqual(crossed.sent.map(asWho), crossed.sent.map(() => [USER_B, ACCOUNT_A]), "sent as bound");
  assert.doesNotMatch(crossed.answer, /The tool said: 5\b/, "the call ran nothing");
  assert.match(crossed.answer, /does not match the provided user ID/, crossed.answer);
  const stranger = await runOnce(s, bind("grep-user-carol-0003"));
  assert.equal(toolCalls(stranger.sent).length, 1, stranger.answer);
  assert.doesNotMatch(stranger.answer, /The tool said: 5\b/, "the call ran nothing");
  assert.match(stranger.answer, /No connected account found for user ID/, stranger.answer);
  assert.equal(stranger.answer.includes("grep-user-carol-0003"), false, "the bound user is cut from what the run shows, Composio's words included");
});

test("the console's edit form previews a per-run server at its saved address ({name, url, auth}): listed as the listing-only user, as a preview by name is", async (t) => {
  const s = await setup(t);
  const shown = (await s.api("GET", "/settings/mcp-servers/mail")).body.url;
  const from = s.composio.mcpLog.length;
  const previewed = await s.api("POST", "/settings/mcp-servers/preview", { name: "mail", url: shown, auth: { type: "headers", headers: { "x-api-key": s.composio.apiKey } } });
  assert.equal(previewed.status, 200, `the edit form's preview listed its tools: ${JSON.stringify(previewed.body)}`);
  const listings = s.composio.mcpLog.slice(from).map((entry) => new URL(entry.path, "http://composio.test").searchParams);
  const users = [...new Set(listings.map((query) => query.get("user_id")))];
  assert.ok(users.length === 1 && users[0] && !COMPOSIO_USER_ID.test(users[0]), `listed as a user no binding can name: ${users}`);
});

const LITERAL = "per_run";
const ISSUES_TRIGGER = { name: "issues", source: { kind: "composio", server: "gh", event: ISSUE_ADDED.slug, config: { owner: "many-drop", repo: "agentrun-scratch" } }, target: { kind: "start_run", agent_id: "triage", input: { content: "Triage this issue." }, max_cost_usd: 0.5 } };

/** A server saved before the per-run mode for a Composio user literally named per_run: Composio's generate names the
 *  user in the address, and a save then kept it there (user_id=per_run), its record with no per_run marker. Made as a
 *  seed user's GitHub server `gh`, then its row and record rewritten to what that save left, with an agent `triage` allowed
 *  its `add`. `triggered`: a Composio trigger `issues` made on it first, as the seed user. */
async function literalPerRunServer(t, { triggered = false } = {}) {
  const composio = await startFakeComposio({ toolkits: { github: { no_auth: false, tools: [ADD] } }, active: ["github"], mcpAccounts: { ...MCP_ACCOUNTS, [LITERAL]: ["ca_literal_github_0001"] } });
  t.after(() => composio.close());
  const server = await serve(t, { faux: FAUX_MCP, composioControl: { baseUrl: composio.baseUrl }, publicUrl: "https://agentrun.example.com" });
  const s = { composio, server, api: server.api };
  const saved = await s.api("PUT", "/settings/mcp-servers/gh/composio", { api_key: composio.apiKey, toolkit: "github", tools: ["add"], user_id: "seed-user-0003" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  // The agent `triage`, allowed its `add`, pinned at the address it is saved with: before the rewrite only when the
  // trigger needs it first.
  const triage = async () => {
    const made = await whenFree(() => s.api("POST", "/agents", agent("triage", { tools: ["mcp:gh/add"], tool_settings: { "mcp:gh/add": { permission: "allow" } } })));
    assert.equal(made.status, 201, JSON.stringify(made.body));
  };
  if (triggered) {
    await triage();
    const trigger = await s.api("POST", "/triggers", ISSUES_TRIGGER);
    assert.equal(trigger.status, 201, JSON.stringify(trigger.body));
  }
  const row = await server.store.mcp.server("gh");
  const url = new URL(row.url);
  url.searchParams.set("user_id", LITERAL);
  assert.ok(await server.store.mcp.rewrite({ name: row.name, url: url.href, auth: row.auth, protocol: row.protocol, tools: row.tools, prices: row.prices, serverInfo: row.serverInfo, instructions: row.instructions }, row.sealed), "the row rewritten");
  const record = await server.store.settings.get(composioMadeKey("gh"));
  assert.equal(record.per_run, undefined, "the seed save wrote no per_run marker");
  await server.store.settings.put(composioMadeKey("gh"), { ...record, user: LITERAL });
  if (!triggered) await triage();
  return s;
}
test("a server saved before the per-run mode for a Composio user literally named per_run (its record names that user, with no per_run marker) stays that user's: no binding switches it to another user, its runs call as it, and it makes a trigger as its account", async (t) => {
  const s = await literalPerRunServer(t);
  const { composio } = s;
  // No user switch: a binding for it is refused as for any server that keeps its own account.
  const before = (await s.api("GET", "/runs")).body.runs.length;
  const from = composio.mcpLog.length;
  const switched = await s.api("POST", "/agents/triage/runs", { input: { content: 'Call mcp__gh__add with {"a":2,"b":3}' }, mcp_auth: { gh: { composio_user_id: USER_A, connected_account_id: ACCOUNT_A } } });
  assert.deepEqual([switched.status, switched.body.error?.fields?.[0]?.field, switched.body.error?.fields?.[0]?.reason], [422, "mcp_auth.gh", "not_an_option"], `a run's caller can't switch the server to another user: ${JSON.stringify(switched.body)}`);
  assert.equal((await s.api("GET", "/runs")).body.runs.length, before, "no run made");
  assert.equal(toolCalls(composio.mcpLog.slice(from)).length, 0, "nothing sent");
  // Its runs call as its fixed user, with no binding.
  const run = await runOnce(s, undefined, { agentId: "triage", content: 'Call mcp__gh__add with {"a":2,"b":3}' });
  assert.equal(toolCalls(run.sent).length, 1, run.answer);
  assert.deepEqual(run.sent.map(asWho), run.sent.map(() => [LITERAL, null]), "every request as its saved user");
  // It has its account: a Composio trigger is made on it, as that user.
  const trigger = await s.api("POST", "/triggers", ISSUES_TRIGGER);
  assert.equal(trigger.status, 201, `a trigger is made on it: ${JSON.stringify(trigger.body)}`);
  assert.deepEqual(composio.calls.filter((call) => /^\/api\/v3\/trigger_instances\/[^/]+\/upsert$/.test(call.path)).map((call) => call.body?.user_id), [LITERAL], "made at Composio as its user");
});

test("saving that server again with user_id per_run while a Composio trigger uses it is 409 composio_in_use: turning it per-run would leave the trigger's account", async (t) => {
  const s = await literalPerRunServer(t, { triggered: true });
  const before = await s.server.store.mcp.server("gh");
  const again = await s.api("PUT", "/settings/mcp-servers/gh/composio", { api_key: s.composio.apiKey, toolkit: "github", tools: ["add"], user_id: "per_run" });
  assert.deepEqual([again.status, again.body.error?.code], [409, "composio_in_use"], `a save that turns it per-run is refused while the trigger uses it: ${JSON.stringify(again.body)}`);
  assert.equal((await s.server.store.mcp.server("gh")).url, before.url, "the server is as it was");
  // Beside it, the same save of a server no trigger uses goes through: the refusal is the trigger's.
  const free = await literalPerRunServer(t);
  const turned = await free.api("PUT", "/settings/mcp-servers/gh/composio", { api_key: free.composio.apiKey, toolkit: "github", tools: ["add"], user_id: "per_run" });
  assert.equal(turned.status, 200, JSON.stringify(turned.body));
  assert.equal(new URL((await free.server.store.mcp.server("gh")).url).searchParams.has("user_id"), false, "saved per-run: its address names no user");
});
