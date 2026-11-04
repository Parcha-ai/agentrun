// MCP tools under the run's one tool gate and its one spend cap, through the API, against the fake MCP server: a denied
// call is refused and the server sees nothing; an allowed one (the agent's exact key, the server's mcp:<server>/*) runs
// once; with no setting an MCP tool asks, and the call is held open (the run reads input_required, pending kind approval,
// held) until the owner's password session answers: an allow sends it once and the same turn goes on, a deny is read by
// the model; parallel asks queue; a restart while held answers the held call interrupted, and a later allow runs it once.
// A tool its owner priced is held at that price under the run's cap (refused unsent when the cap cannot take it) and
// booked as the run's tool cost; one with no price runs "not metered". pi (the faux model) and claude-agent (the pinned
// Agent SDK and Claude CLI). No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, call, cookieOf, follow, serve as serveOf, withEnv } from "./support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const TOKEN = `not-a-secret-${"mcp-gate-bearer-0123"}`;
const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const json = { "content-type": "application/json" };
/** A server that seals saved credentials and has an owner who signs in with a password. */
const serve = (t, options = {}) => (withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }), serveOf(t, { faux: FAUX_MCP, accounts: true, openSetup: true, ...options }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const calls = (fake, tool) => fake.log.filter((entry) => entry.method === "tools/call" && (tool === undefined || entry.tool === tool));
const ADD = 'Call mcp__fake__add with {"a":2,"b":3}';
const PAID = 'Call mcp__fake__paid with {"query":"ada"}';

/** The fake MCP server saved as `fake`, with `prices` when given. */
async function addFake(t, api, prices) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const saved = await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN }, ...(prices ? { prices } : {}) });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return fake;
}

/** Agent `id` granted `tools` (and `extra`), and one run of it asking `content` (with `run`'s fields). */
async function started(api, id, tools, content, { extra = {}, run = {} } = {}) {
  const made = await api("POST", "/agents", agent(id, { tools, ...extra }));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const started = await api("POST", `/agents/${id}/runs`, { input: { content }, ...run });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return started.body.run_id;
}

/** The owner's password session: an answer to approval `approvalId` of run `runId`, as the console sends it. */
async function owner(server) {
  const origin = `http://127.0.0.1:${server.port}`;
  const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { ...json, origin }, body: { password: SIGN_IN_PHRASE } });
  assert.equal(setup.status, 201, setup.text);
  const cookie = cookieOf(setup);
  return async (runId, approvalId, body) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body })).status;
}

/** Run `runId` holding a call for its approval: its pending approval, once it reads input_required. */
async function held(api, runId) {
  await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(view.pending?.kind, "approval", JSON.stringify(view.pending));
  return view.pending;
}

const answerOf = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer;
const allowFake = (api) => api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "allow" } });

test("prices: a PUT keeps each tool's price in USD a call, a read shows them, and a price that is not a finite number 0 or more, or names a tool the server does not list, is 422 and nothing is saved", async (t) => {
  const server = await serve(t);
  const { api } = server;
  const fake = await addFake(t, api, { paid: 0.05, add: 0 });
  assert.deepEqual((await api("GET", "/settings/mcp-servers/fake")).body.prices, { paid: 0.05, add: 0 });
  assert.deepEqual((await api("GET", "/settings/mcp-servers")).body.servers[0].prices, { paid: 0.05, add: 0 });
  for (const [prices, field] of [[{ nope: 1 }, "prices.nope"], [{ paid: -0.01 }, "prices.paid"], [{ paid: "0.05" }, "prices.paid"], [[0.05], "prices"]]) {
    const refused = await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN }, prices });
    assert.equal(refused.status, 422, JSON.stringify([prices, refused.body]));
    assert.ok(JSON.stringify(refused.body).includes(field), JSON.stringify(refused.body));
  }
  // JSON's 1e400 reads as Infinity: not a price.
  const infinite = await call(server.port, { method: "PUT", path: "/v2/settings/mcp-servers/fake", headers: { ...json, authorization: `Bearer ${server.token}` }, body: `{"url":${JSON.stringify(fake.url)},"auth":{"type":"bearer","token":"${TOKEN}"},"prices":{"paid":1e400}}` });
  assert.equal(infinite.status, 422, infinite.text);
  assert.deepEqual((await api("GET", "/settings/mcp-servers/fake")).body.prices, { paid: 0.05, add: 0 }, "nothing refused was saved");
  const doc = (await api("GET", "/openapi.json")).body;
  const put = doc.paths["/settings/mcp-servers/{name}"].put.requestBody.content["application/json"].schema;
  assert.ok(put.properties.prices, "the PUT documents prices");
});

test("pi: an MCP tool set to deny is refused, the model reads why, and the server sees nothing", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t);
  const fake = await addFake(t, api);
  const runId = await started(api, "denied", ["mcp:fake/add"], ADD, { extra: { tool_settings: { "mcp:fake/add": { permission: "deny" } } } });
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed");
  assert.equal(await answerOf(api, runId), "The tool said: Permission denied: mcp:fake/add is set to deny on this server. Don't retry it.");
  assert.equal(calls(fake).length, 0, "nothing was sent");
});

test("pi: allowed by the agent's exact key, or by the server's mcp:fake/*, the call runs once with no person asked", { timeout: 120_000 }, async (t) => {
  const { api } = await serve(t);
  const fake = await addFake(t, api);
  const exact = await started(api, "exact", ["mcp:fake/add"], ADD, { extra: { tool_settings: { "mcp:fake/add": { permission: "allow" } } } });
  await follow(api, exact, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await answerOf(api, exact), "The tool said: 5");
  assert.equal((await allowFake(api)).status, 200);
  const wide = await started(api, "wide", ["mcp:fake/add"], ADD);
  await follow(api, wide, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await answerOf(api, wide), "The tool said: 5");
  assert.equal(calls(fake, "add").length, 2, "one call each");
});

test("pi: with no setting an MCP tool asks: the call is held, the run reads input_required with the approval (held, the tool, its arguments, its price); the owner's allow sends it once and the same turn goes on; a token cannot answer", { timeout: 120_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api, { paid: 0.05 });
  const runId = await started(api, "asker", ["mcp:fake/paid"], PAID);
  const pending = await held(api, runId);
  assert.deepEqual([pending.tool, pending.held, pending.price, JSON.parse(pending.args_preview)], ["mcp:fake/paid", true, 0.05, { query: "ada" }]);
  const { rows } = await follow(api, runId, ["input_required"]);
  assert.ok(rows.some((row) => row.kind === "phase" && /approval/i.test(row.summary ?? "")) || rows.some((row) => row.summary?.includes("mcp:fake/paid")), "the timeline shows the call waits");
  assert.equal(calls(fake).length, 0, "nothing is sent while it waits");
  assert.equal((await api("POST", `/runs/${runId}/approvals/${pending.id}`, { decision: "allow" })).status, 403, "a token never answers");
  assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await answerOf(api, runId), "The tool said: paid for ada");
  assert.equal(calls(fake, "paid").length, 1, "sent once");
  const users = (await follow(api, runId, ["completed"])).rows.filter((row) => row.kind === "user_message");
  assert.equal(users.length, 1, "the same turn went on: no resume message");
});

test("pi: a held call the owner denies is never sent, and the model reads the denial and their reason", { timeout: 120_000 }, async (t) => {
  const server = await serve(t);
  const answer = await owner(server);
  const fake = await addFake(t, server.api);
  const runId = await started(server.api, "refused", ["mcp:fake/add"], ADD);
  const pending = await held(server.api, runId);
  assert.equal(pending.price, "not metered");
  assert.equal(await answer(runId, pending.id, { decision: "deny", note: "not today" }), 204);
  await follow(server.api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await answerOf(server.api, runId), "The tool said: The user denied this mcp:fake/add call. Reason: not today");
  assert.equal(calls(fake).length, 0);
});

test("pi: two asks at once queue: the second's approval is raised once the first is answered, and each allowed call is sent once", { timeout: 150_000 }, async (t) => {
  const server = await serve(t);
  const answer = await owner(server);
  const fake = await addFake(t, server.api);
  const runId = await started(server.api, "pair", ["mcp:fake/add"], `Calls ${JSON.stringify([["mcp__fake__add", { a: 1, b: 1 }], ["mcp__fake__add", { a: 2, b: 2 }]])}`);
  const first = await held(server.api, runId);
  assert.equal(await answer(runId, first.id, { decision: "allow" }), 204);
  let second;
  for (let i = 0; !second; i++) {
    assert.ok(i < 300, "the second call's approval is raised");
    const view = (await server.api("GET", `/runs/${runId}`)).body;
    if (view.pending?.kind === "approval" && view.pending.id !== first.id) second = view.pending;
    else await sleep(100);
  }
  assert.notEqual(second.args_preview, first.args_preview);
  assert.equal(await answer(runId, second.id, { decision: "allow" }), 204);
  await follow(server.api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await answerOf(server.api, runId), "The tool said: 2 | 4");
  assert.equal(calls(fake, "add").length, 2);
});

test("pi: the run's process killed while a call is held: the call is answered interrupted, its approval stays pending, and a later allow sends it once", { timeout: 180_000 }, async (t) => {
  const server = await serve(t);
  const { api, data } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  const runId = await started(api, "crash", ["mcp:fake/add"], ADD);
  const pending = await held(api, runId);
  const record = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8"));
  process.kill(record.holder.pid, "SIGKILL");
  const again = await held(api, runId);
  assert.equal(again.id, pending.id, "the same approval");
  const { rows } = await follow(api, runId, ["input_required"]);
  assert.ok(rows.some((row) => row.kind === "tool_result" && /interrupted/i.test(`${row.summary} ${row.tool_result_preview}`)), "the held call answered interrupted");
  assert.equal(calls(fake).length, 0);
  assert.equal(await answer(runId, again.id, { decision: "allow" }), 204);
  await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
  assert.equal(calls(fake, "add").length, 1, "sent once, by the gate's executor");
  assert.match(await answerOf(api, runId), /5/);
});

test("pi: a tool priced $0.05 under a $0.04 cap is refused unsent in the cap's words; under a $1 cap it is sent and booked as a $0.05 tool cost", { timeout: 150_000 }, async (t) => {
  const { api } = await serve(t);
  const fake = await addFake(t, api, { paid: 0.05 });
  const tight = await started(api, "tight", ["mcp:fake/paid"], PAID, { run: { max_cost_usd: 0.04 } });
  await follow(api, tight, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.match(await answerOf(api, tight), /^The tool said: spend_cap_reached: mcp:fake\/paid was not sent\. It could cost up to \$0\.05/);
  assert.equal(calls(fake).length, 0, "refused unsent");
  const roomy = await started(api, "roomy", ["mcp:fake/paid"], PAID, { run: { max_cost_usd: 1 } });
  const { rows } = await follow(api, roomy, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await answerOf(api, roomy), "The tool said: paid for ada");
  assert.equal(calls(fake, "paid").length, 1);
  const charge = rows.find((row) => row.kind === "phase" && row.tool_name === "mcp:fake/paid");
  assert.deepEqual([charge?.summary, charge?.usage?.usd], ["Tool cost: fake charged $0.0500 for mcp:fake/paid", 0.05], JSON.stringify(rows.filter((row) => row.kind === "phase")));
  const view = (await api("GET", `/runs/${roomy}`)).body;
  assert.equal(view.cost?.usd, 0.05, "the faux model is free: the run's cost is the tool's");
  const tools = (await api("GET", "/usage?group_by=meter")).body.lines.find((line) => line.meter === "tools");
  assert.equal(tools?.usd, 0.05, JSON.stringify(tools));
});

test("pi: a tool with no price runs, shown not metered on the timeline and in /usage, outside the run's cost", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t);
  const fake = await addFake(t, api);
  const runId = await started(api, "free", ["mcp:fake/add"], ADD, { run: { max_cost_usd: 0.04 } });
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await answerOf(api, runId), "The tool said: 5");
  assert.equal(calls(fake, "add").length, 1);
  const unmetered = rows.find((row) => row.kind === "phase" && row.tool_name === "mcp:fake/add");
  assert.match(unmetered?.summary ?? "", /^Not metered: mcp:fake\/add/, JSON.stringify(rows.filter((row) => row.kind === "phase")));
  assert.equal(unmetered.usage, undefined, "no charge, never unknown");
  const usage = rows.find((row) => row.kind === "usage");
  assert.deepEqual([usage?.usage?.usd, usage?.usage?.not_metered], [0, 1], JSON.stringify(usage));
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost?.usd, 0, "known, never unknown");
  const tools = (await api("GET", "/usage?group_by=meter")).body.lines.find((line) => line.meter === "tools");
  assert.deepEqual([tools?.usd, tools?.not_metered_calls], [0, 1], JSON.stringify(tools));
});

test("claude-agent: with no setting the CLI's MCP call is held at the session proxy until the owner allows it, then sent once and the same turn goes on", { timeout: 240_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const anthropic = await fakeAnthropic({
    reply: (request) => (Object.keys(request.results).length ? { text: `The tool said: ${Object.values(request.results)[0]}` } : request.tools.includes("mcp__fake__add") ? { tool: { name: "mcp__fake__add", input: { a: 2, b: 3 } } } : { text: "Noted." }),
  });
  t.after(() => anthropic.close());
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  delete process.env.AGENT_MODEL_BASE_URL;
  Object.assign(process.env, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: anthropic.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" });
  const server = await serve(t, { faux: undefined });
  const answer = await owner(server);
  const fake = await addFake(t, server.api);
  const runId = await started(server.api, "claude-asker", ["mcp:fake/add"], "Add 2 and 3 with the add tool.", { extra: { harness: "claude-agent", model: "anthropic/claude-haiku-4-5" } });
  const pending = await held(server.api, runId);
  assert.deepEqual([pending.tool, pending.held, pending.price], ["mcp:fake/add", true, "not metered"]);
  // Held past a minute: the CLI's own MCP timeout is the run's limit, and the proxy keeps the call alive.
  await sleep(65_000);
  assert.equal(calls(fake).length, 0);
  assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
  const { rows } = await follow(server.api, runId, ["completed", "failed"], { deadlineMs: 120_000 });
  assert.match(await answerOf(server.api, runId) ?? "", /^The tool said: 5\b/, JSON.stringify(rows.filter((row) => row.kind === "error" || row.kind.startsWith("tool"))));
  assert.equal(calls(fake, "add").length, 1);
  assert.equal(rows.filter((row) => row.kind === "user_message").length, 1, "the same turn went on");
});
