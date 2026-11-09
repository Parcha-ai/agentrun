// MCP tools under the run's one tool gate and its one spend cap, through the API, against the fake MCP server: a denied
// call is refused and the server sees nothing; an allowed one (the agent's exact key, the server's mcp:<server>/*) runs
// once; with no setting an MCP tool asks: the call parks and the turn ends (the run reads input_required, pending kind
// approval, with the call's price or "not metered"), the server sees nothing, and the owner's password session answers:
// an allow runs it once and resumes the run with its result, a deny resumes it with the refusal; a restart while parked
// loses nothing. A tool its owner priced is held at that price under the run's cap (refused unsent when the cap cannot
// take it) and booked as the run's tool cost; one with no price runs "not metered". pi (the faux model), claude-agent
// (the pinned Agent SDK and Claude CLI) and codex (the stand-in for Codex's app-server). No key, no network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeAnthropic } from "@parcha/agentrun-harness-claude/testing";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { notedRequests, REQUESTS_ENV, rolesOf } from "./fixtures/faux-requests.mjs";
import { noApproverText } from "../dist/tool-gate.js";
import { schemaProblems } from "./schema-support.mjs";
import { copyStandIn } from "../../run-adapters-codex/test/stand-in.mjs";
import { agent, call, clientOwnerSession, follow, runDir, runRecordOf, scratch, serve as serveOf, startInProcessRunner, withEnv } from "./support.mjs";
import { HOLD_ENV } from "./fixtures/faux-mcp.mjs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const { journalRecords } = await import("../dist/runner/journal-reader.js");

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const TOKEN = `not-a-secret-${"mcp-gate-bearer-0123"}`;
const json = { "content-type": "application/json" };
/** A server that seals saved credentials and has an owner who signs in with a password. */
const serve = (t, options = {}) => (withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }), serveOf(t, { faux: FAUX_MCP, accounts: true, openSetup: true, ...options }));
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
  // The owner's session the test client holds (its one owner on this server), as the console sends an answer.
  const { cookie, origin } = await clientOwnerSession(server);
  const send = (runId, approvalId, body) => call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body });
  // The answer's status; `refused` the status and words of a refused one (its error's message).
  return Object.assign(async (runId, approvalId, body) => (await send(runId, approvalId, body)).status, {
    refused: async (runId, approvalId, body) => {
      const sent = await send(runId, approvalId, body);
      return [sent.status, sent.json?.error?.message ?? sent.text];
    },
  });
}

/** Run `runId` parked on a call that waits for its approval: its pending approval, once it reads input_required. */
/** One MCP call asks the gate once: exactly one approval is requested for it (only the gateway enters the gate for an
 *  MCP call; no harness path does too). */
async function parked(api, runId) {
  const { rows } = await follow(api, runId, ["input_required"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(view.pending?.kind, "approval", JSON.stringify(view.pending));
  const asked = rows.filter((row) => row.kind === "tool_approval_requested");
  assert.deepEqual(asked.map((row) => row.tool_name), [view.pending.tool], `exactly one approval for the call: ${JSON.stringify(asked)}`);
  return view.pending;
}

const answerOf = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer;
const allowFake = (api) => api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "allow" } });

/** The gate's resume of call `callId` on run `runId`'s timeline: AgentRun's row (origin "server"), never a person's, with no
 *  call id in its summary or its text. */
async function resumeRowIsAgentRuns(api, runId, callId, tool, at) {
  const { rows } = await follow(api, runId, ["completed", "failed"]);
  const resume = rows.find((row) => row.origin === "server" && (row.summary ?? "").startsWith(`AgentRun: ${tool} `));
  assert.deepEqual([resume?.kind, resume?.origin, resume?.summary], ["phase", "server", `AgentRun: ${tool} ran once you allowed it; its result went to the agent`], `${at}: ${JSON.stringify(resume)}`);
  assert.ok(!`${resume.summary} ${resume.text ?? ""}`.includes(callId), `${at}: no call id: ${resume.text}`);
  assert.ok(!rows.some((row) => row.kind === "user_message" && `${row.text ?? ""} ${row.summary ?? ""}`.includes("[tool approval]")), `${at}: never a "You" row`);
}

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
  // Sent as the console sends a secret write (the body carries the bearer): from the owner's session.
  const { cookie, origin } = await clientOwnerSession(server);
  const infinite = await call(server.port, { method: "PUT", path: "/v2/settings/mcp-servers/fake", headers: { ...json, cookie, origin }, body: `{"url":${JSON.stringify(fake.url)},"auth":{"type":"bearer","token":"${TOKEN}"},"prices":{"paid":1e400}}` });
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
  assert.equal(await answerOf(api, runId), "The tool said: Permission denied: mcp:fake/add is set to deny for this agent. It was not run: nothing was sent and nothing was charged. Don't retry it.");
  assert.equal(calls(fake).length, 0, "nothing was sent");
});

test("pi: on a server with accounts off no one can approve, so an MCP tool's ask is refused at once in words, and the server sees nothing", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t, { accounts: false, openSetup: false });
  const fake = await addFake(t, api);
  const runId = await started(api, "unattended", ["mcp:fake/add"], ADD);
  const { last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  assert.equal(last.status, "completed");
  assert.equal(await answerOf(api, runId), `The tool said: ${noApproverText("mcp:fake/add")}`);
  assert.equal(calls(fake).length, 0, "nothing was sent");
});

test("pi: allowed by the agent's exact key, or by the server's mcp:fake/*, the call runs once with no person asked", { timeout: 120_000 }, async (t) => {
  // Each request pi's faux model is asked, by run: counted below, and shown with the server's calls when a count is wrong.
  const requests = join(await scratch(t), "requests.jsonl");
  withEnv(t, { [REQUESTS_ENV]: requests });
  const { api } = await serve(t);
  const fake = await addFake(t, api);
  // The runs share the in-process runner's process, one after the other: each run's requests are the ones noted while it
  // ran, from its start to its end.
  const exact = await started(api, "exact", ["mcp:fake/add"], ADD, { extra: { tool_settings: { "mcp:fake/add": { permission: "allow" } } } });
  await follow(api, exact, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await answerOf(api, exact), "The tool said: 5");
  const afterExact = notedRequests(requests).length;
  assert.equal((await allowFake(api)).status, 200);
  const wide = await started(api, "wide", ["mcp:fake/add"], ADD);
  await follow(api, wide, ["completed"], { deadlineMs: 60_000 });
  assert.equal(await answerOf(api, wide), "The tool said: 5");
  const byRun = { exact: notedRequests(requests).slice(0, afterExact), wide: notedRequests(requests).slice(afterExact) };
  // Each run asked its model twice: the message (the call), then the call's result (the answer). A third request is a
  // real extra one, whatever the faux model made of it.
  // Both runs' request roles and the server's calls (JSON-RPC id, time), in either failure's message: an extra request is
  // explained by the calls it made, and an extra call by the requests around it.
  const seen = `exact ${rolesOf(byRun.exact)}; wide ${rolesOf(byRun.wide)}; the server's calls ${JSON.stringify(calls(fake, "add").map((entry) => ({ id: entry.id, at: entry.at })))}`;
  for (const name of ["exact", "wide"]) assert.equal(byRun[name].length, 2, `${name}: one request for the call, one for its answer: ${seen}`);
  assert.equal(calls(fake, "add").length, 2, `one call each: ${seen}`);
});

test("pi: with no setting an MCP tool asks once (exactly one approval): the call parks and the turn ends, the run reads input_required with the approval (the tool, its arguments, its price) and the server saw nothing; a token cannot answer; the owner's allow runs it once and resumes the run with its result", { timeout: 120_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api, { paid: 0.05 });
  const runId = await started(api, "asker", ["mcp:fake/paid"], PAID);
  const pending = await parked(api, runId);
  assert.deepEqual([pending.tool, pending.price, JSON.parse(pending.args_preview)], ["mcp:fake/paid", 0.05, { query: "ada" }]);
  assert.equal(calls(fake).length, 0, "nothing is sent while it waits");
  assert.equal((await api("POST", `/runs/${runId}/approvals/${pending.id}`, { decision: "allow" })).status, 403, "a token never answers");
  assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
  await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  // On the runner, pi's answered call reaches the model as the call's own result (the faux model's "The tool said").
  assert.equal(await answerOf(api, runId), "The tool said: paid for ada");
  assert.equal(calls(fake, "paid").length, 1, "run once, by the gate");
  await resumeRowIsAgentRuns(api, runId, pending.call_id, "mcp:fake/paid", "pi");
});

test("pi: an approved call whose arguments quote the gate's own words: the opened resume row shows only the outcome and the result", { timeout: 120_000 }, async (t) => {
  const SENTENCE = "which waited for a person's approval; it is not a new message from them.";
  const server = await serve(t);
  const { api } = server;
  const answer = await owner(server);
  await addFake(t, api, { paid: 0.05 });
  const runId = await started(api, "quoting", ["mcp:fake/paid"], `Call mcp__fake__paid with ${JSON.stringify({ query: SENTENCE })}`);
  const pending = await parked(api, runId);
  assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
  const { rows } = await follow(api, runId, ["completed"], { deadlineMs: 60_000 });
  const resume = rows.find((row) => row.origin === "server" && (row.summary ?? "").startsWith("AgentRun: mcp:fake/paid "));
  assert.equal(resume?.text, `mcp:fake/paid ran once you allowed it. Its result:\npaid for ${SENTENCE}`, JSON.stringify(resume));
});

test("pi: an MCP tool's default ask shows not metered when it has no price; the owner's deny resumes the run with the refusal and nothing is sent", { timeout: 120_000 }, async (t) => {
  const server = await serve(t);
  const answer = await owner(server);
  const fake = await addFake(t, server.api);
  const runId = await started(server.api, "refused", ["mcp:fake/add"], ADD);
  const pending = await parked(server.api, runId);
  assert.equal(pending.price, "not metered");
  assert.equal(await answer(runId, pending.id, { decision: "deny", note: "not today" }), 204);
  await follow(server.api, runId, ["completed"], { deadlineMs: 60_000 });
  // The refusal reaches pi's model as the call's own result.
  assert.equal(await answerOf(server.api, runId), "The tool said: The user denied this mcp:fake/add call. It was not run: nothing was sent and nothing was charged. Reason: not today");
  assert.equal(calls(fake).length, 0);
});

test("pi: the run's process killed while a call is parked loses nothing: the same approval waits, and an allow runs it once", { timeout: 180_000 }, async (t) => {
  const server = await serve(t);
  const { api, data } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  const runId = await started(api, "crash", ["mcp:fake/add"], ADD);
  const pending = await parked(api, runId);
  const record = runRecordOf(data, runId);
  if (record.holder?.pid) process.kill(record.holder.pid, "SIGKILL");
  const again = await parked(api, runId);
  assert.equal(again.id, pending.id, "the same approval");
  assert.equal(await answer(runId, again.id, { decision: "allow" }), 204);
  await follow(api, runId, ["completed"], { deadlineMs: 90_000 });
  assert.equal(await answerOf(api, runId), "The tool said: 5");
  assert.equal(calls(fake, "add").length, 1, "run once");
});

test("pi: a paid call that ran before a crash keeps its result when its tool is set to deny before the run reopens: the model gets the saved result, never that nothing was charged, and it is booked once", { timeout: 240_000 }, async (t) => {
  // On the runner: the runner holding the run goes after the call ran and before the model read its result (the faux
  // model holds that request until the runner lets it go), and another runner claims the run and resumes it.
  const crashed = join(await mkdtemp(join(tmpdir(), "gate-crash-")), "crashed");
  withEnv(t, { [HOLD_ENV]: crashed });
  const server = await serve(t, { runner: false });
  const { api, data } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api, { paid: 0.05 });
  const closeFirst = await startInProcessRunner(data, { faux: FAUX_MCP });
  let firstClosed = false;
  t.after(() => (firstClosed ? undefined : closeFirst()));
  const runId = await started(api, "ran-then-deny", ["mcp:fake/paid"], PAID);
  const pending = await parked(api, runId);
  assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
  for (let i = 0; !existsSync(crashed); i++) {
    assert.ok(i < 600, "the approved call runs and the model is asked to read its result");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(calls(fake, "paid").length, 1, "the approved call reached the server");
  // The call ran and its outcome is in the journal; its tool is set to deny before the runner goes and the run reopens.
  assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/paid": { permission: "deny" } })).status, 200);
  await closeFirst();
  firstClosed = true;
  const closeSecond = await startInProcessRunner(data, { faux: FAUX_MCP });
  t.after(() => closeSecond());
  const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 150_000 });
  assert.ok(existsSync(crashed), "the process went between the call and its resume");
  const said = (await answerOf(api, runId)) ?? "";
  assert.equal(said, "The tool said: paid for ada", "the model gets the call's saved result");
  assert.ok(!said.includes("nothing was charged"), said);
  assert.equal(rows.filter((row) => /^Tool cost:/.test(row.summary ?? "")).length, 1, "booked once");
  assert.equal(calls(fake, "paid").length, 1, "never run again");
});

test("pi: a priced MCP call is never sent or charged on any deny, and the model reads so plainly: the owner's deny, a deny setting, and a declining message", { timeout: 180_000 }, async (t) => {
  const NOT_RUN = "It was not run: nothing was sent and nothing was charged.";
  const server = await serve(t);
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api, { paid: 0.05 });
  const asked = await started(api, "deny-paid", ["mcp:fake/paid"], PAID);
  const pending = await parked(api, asked);
  assert.equal(await answer(asked, pending.id, { decision: "deny" }), 204);
  const set = await started(api, "set-deny-paid", ["mcp:fake/paid"], PAID, { extra: { tool_settings: { "mcp:fake/paid": { permission: "deny" } } } });
  const declined = await started(api, "msg-paid", ["mcp:fake/paid"], PAID);
  await parked(api, declined);
  assert.equal((await api("POST", `/runs/${declined}/messages`, { content: "skip the paid lookup" })).status, 202);
  for (const [runId, how] of [[asked, "the owner's deny"], [set, "a deny setting"], [declined, "a declining message"]]) {
    const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
    const said = (await answerOf(api, runId)) ?? "";
    assert.ok(said.includes(NOT_RUN), `${how}: the model reads that nothing was sent or charged: ${said}`);
    assert.ok(!rows.some((row) => /^Tool cost:/.test(row.summary ?? "")), `${how}: no tool cost is booked`);
  }
  assert.equal(calls(fake).length, 0, "the server saw nothing");
});

test("pi: a tool priced $0.05 under a $0.04 cap is refused unsent in the cap's words and the run waits on a raise; under a $1 cap it is sent and booked as a $0.05 tool cost", { timeout: 150_000 }, async (t) => {
  const { api } = await serve(t);
  const fake = await addFake(t, api, { paid: 0.05 });
  assert.equal((await allowFake(api)).status, 200);
  const tight = await started(api, "tight", ["mcp:fake/paid"], PAID, { run: { max_cost_usd: 0.04 } });
  await follow(api, tight, ["input_required"], { deadlineMs: 60_000 });
  // A paid call the cap refuses pauses the run for a raise, as any paid tool's does: its price is what it needs.
  const paused = (await api("GET", `/runs/${tight}`)).body;
  assert.deepEqual([paused.state, paused.pending?.kind, paused.pending?.cap_usd, paused.pending?.needs_usd], ["waiting", "budget", 0.04, 0.05], JSON.stringify(paused.pending));
  assert.match(paused.pending.said, /Not sent: this run has spent \$0 of its \$0\.04 cap, and the next step, mcp:fake\/paid, could cost up to \$0\.05 \(the price its owner set for mcp:fake\/paid\)/);
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

test("pi: a tool with no price runs, shown not metered on the timeline and in /usage, outside the run's cost; a $0 run shows its tools line only for such calls", { timeout: 90_000 }, async (t) => {
  const { api } = await serve(t);
  const fake = await addFake(t, api);
  // A $0 run that calls no MCP tool reads on /usage as it always has: its tokens line, no $0 line of tools.
  const plain = await started(api, "plain", [], "Hello.");
  await follow(api, plain, ["completed"], { deadlineMs: 60_000 });
  assert.deepEqual((await api("GET", "/usage?group_by=meter")).body.lines, [{ group: "tokens", meter: "tokens", usd: 0, unpriced_runs: 0 }]);
  assert.equal((await allowFake(api)).status, 200);
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
  // Both counts meet the served document.
  const doc = (await api("GET", "/openapi.json")).body;
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/TimelineUsage" }, usage.usage), []);
  assert.deepEqual(schemaProblems(doc, { $ref: "#/components/schemas/UsageLine" }, tools), []);
});

test("claude-agent: with no setting the CLI's MCP call asks once (exactly one approval) and parks: the session is interrupted after its parked result with no model request between, the run reads input_required, and the owner's allow runs it once and resumes the run", { timeout: 240_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const anthropic = await fakeAnthropic({
    reply: (request) => {
      // The gate's resume of the answered call (the CLI may wrap it, so it is found in the conversation's text).
      const at = request.text.lastIndexOf("[tool approval]");
      if (at >= 0) return { text: `Resumed: ${request.text.slice(at).split("\n")[1] ?? ""}` };
      if (Object.keys(request.results).length) return { text: `The tool said: ${Object.values(request.results)[0]}` };
      return request.tools.includes("mcp__fake__add") ? { tool: { name: "mcp__fake__add", input: { a: 2, b: 3 } } } : { text: "Noted." };
    },
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
  const pending = await parked(server.api, runId);
  assert.deepEqual([pending.tool, pending.price], ["mcp:fake/add", "not metered"]);
  // The parked result ended the turn: no model request carried it back.
  assert.ok(!anthropic.requests.some((request) => Object.keys(request.results).length), "no request left after the parked result");
  const { rows } = await follow(server.api, runId, ["input_required"]);
  assert.ok(rows.some((row) => row.kind === "tool_result" && row.tool_name === "mcp__fake__add"), "the parked result is on the timeline");
  assert.equal(calls(fake).length, 0);
  assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
  await follow(server.api, runId, ["completed", "failed"], { deadlineMs: 120_000 });
  assert.match(await answerOf(server.api, runId) ?? "", /^Resumed: 5\b/);
  assert.equal(calls(fake, "add").length, 1, "run once, by the gate");
  await resumeRowIsAgentRuns(server.api, runId, pending.call_id, "mcp:fake/add", "claude-agent");
});

test("claude-agent: a priced call through the CLI's own MCP client is held and booked under the run's cap, and an unpriced one is marked not metered", { timeout: 240_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const anthropic = await fakeAnthropic({
    reply: (request) => (Object.keys(request.results).length ? { text: `The tool said: ${Object.values(request.results)[0]}` } : request.tools.includes("mcp__fake__paid") ? { tool: { name: "mcp__fake__paid", input: { query: "ada" } } } : request.tools.includes("mcp__fake__add") ? { tool: { name: "mcp__fake__add", input: { a: 2, b: 3 } } } : { text: "Noted." }),
  });
  t.after(() => anthropic.close());
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  delete process.env.AGENT_MODEL_BASE_URL;
  Object.assign(process.env, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: anthropic.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" });
  const { api } = await serve(t, { faux: undefined });
  const fake = await addFake(t, api, { paid: 0.05 });
  const claude = { harness: "claude-agent", model: "anthropic/claude-haiku-4-5" };
  assert.equal((await allowFake(api)).status, 200);
  const paid = await started(api, "claude-paid", ["mcp:fake/paid"], "Look up ada with the paid tool.", { extra: claude, run: { max_cost_usd: 2 } });
  const free = await started(api, "claude-free", ["mcp:fake/add"], "Add 2 and 3 with the add tool.", { extra: claude });
  for (const [runId, tool, summary] of [[paid, "mcp:fake/paid", /^Tool cost: fake charged \$0\.0500 for mcp:fake\/paid$/], [free, "mcp:fake/add", /^Not metered: mcp:fake\/add/]]) {
    const { rows, last } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 150_000 });
    assert.equal(last.status, "completed", JSON.stringify(rows.filter((row) => row.kind === "error" || row.kind.startsWith("tool"))));
    assert.match(rows.find((row) => row.kind === "phase" && row.tool_name === tool)?.summary ?? "", summary, JSON.stringify(rows.filter((row) => row.kind === "phase")));
  }
  assert.deepEqual([calls(fake, "paid").length, calls(fake, "add").length], [1, 1]);
});

/** A priced call the cap has no room for pauses the run for a raise in the cap's words, and the server sees nothing. */
function pausedForRoom(view, fake) {
  assert.deepEqual([view.state, view.pending?.kind, view.pending?.cap_usd], ["waiting", "budget", 0.04], JSON.stringify(view.pending));
  assert.ok(view.pending.needs_usd >= 0.05, JSON.stringify(view.pending));
  // The cap's words, as main says them (#1768).
  assert.match(view.pending.said, /Not sent: this run has spent \$[\d.]+ of its \$0\.04 cap, and the next step, mcp:fake\/paid, could cost up to \$0\.05 \(the price its owner set for mcp:fake\/paid\)/);
  assert.equal(calls(fake).length, 0, "refused unsent");
}

test("claude-agent: a call through the CLI's own MCP client priced $0.05 under a $0.04 cap is refused unsent and pauses the run for a raise", { timeout: 240_000, skip: !existsSync("/usr/bin/setpriv") && "no setpriv here" }, async (t) => {
  const anthropic = await fakeAnthropic({
    reply: (request) => (Object.keys(request.results).length ? { text: `The tool said: ${Object.values(request.results)[0]}` } : request.tools.includes("mcp__fake__paid") ? { tool: { name: "mcp__fake__paid", input: { query: "ada" } } } : { text: "Noted." }),
  });
  t.after(() => anthropic.close());
  withEnv(t, { ANTHROPIC_API_KEY: `not-a-secret-${"anthropic"}`, ANTHROPIC_BASE_URL: anthropic.url, AGENT_MODEL: "anthropic/claude-haiku-4-5" }, ["AGENT_MODEL_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "AGENT_MODEL"]);
  const { api } = await serve(t, { faux: undefined });
  const fake = await addFake(t, api, { paid: 0.05 });
  assert.equal((await allowFake(api)).status, 200);
  const runId = await started(api, "claude-tight", ["mcp:fake/paid"], "Look up ada with the paid tool.", { extra: { harness: "claude-agent", model: "anthropic/claude-haiku-4-5" }, run: { max_cost_usd: 0.04 } });
  await follow(api, runId, ["input_required"], { deadlineMs: 150_000 });
  pausedForRoom((await api("GET", `/runs/${runId}`)).body, fake);
});

test("codex: a call through Codex's own MCP client priced $0.05 under a $0.04 cap is refused unsent and pauses the run for a raise", { timeout: 150_000 }, async (t) => {
  const standIn = join(await scratch(t), "codex-stand-in.mjs");
  await copyStandIn(standIn);
  const gateway = createServer(async (req, res) => {
    if (!req.url?.startsWith("/v1/")) return void res.writeHead(404).end();
    let body = "";
    for await (const chunk of req) body += chunk;
    const text = JSON.parse(body || "{}").input?.[0]?.content?.[0]?.text ?? "";
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 10 } } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  withEnv(t, {
    AGENTRUN_CODEX_STANDIN: "1",
    AGENTRUN_SERVE_CODEX_STANDIN: JSON.stringify({ command: process.execPath, args: [standIn], env: { FAKE_CODEX_MODEL: "remote" } }),
    AGENT_MODEL_BASE_URL: `http://127.0.0.1:${gateway.address().port}`,
    AGENT_MODEL: "gpt-test",
    AGENT_MODEL_API_KEY: `not-a-secret-${"gateway"}`,
    AGENT_MODEL_PRICE: "1,2,0.5",
  }, ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_API_KEY", "AGENT_MODEL_PRICE", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]);
  const { api } = await serve(t, { faux: undefined });
  const fake = await addFake(t, api, { paid: 0.05 });
  assert.equal((await allowFake(api)).status, 200);
  const runId = await started(api, "codex-tight", ["mcp:fake/paid"], 'mcp fake paid {"query":"ada"}', { extra: { harness: "codex" }, run: { max_cost_usd: 0.04 } });
  await follow(api, runId, ["input_required"], { deadlineMs: 120_000 });
  pausedForRoom((await api("GET", `/runs/${runId}`)).body, fake);
});

/** A server for `harness` with the owner signed in and the fake saved: pi on the faux model, claude-agent on the pinned
 *  Agent SDK and CLI against a scripted Messages endpoint that calls add, then answers with the gate's resume. */
async function parkingServer(t, harness, { tool = "add", input = { a: 2, b: 3 } } = {}) {
  if (harness === "pi") {
    const server = await serve(t);
    return { server, answer: await owner(server), fake: await addFake(t, server.api), extra: {}, content: `Call mcp__fake__${tool} with ${JSON.stringify(input)}` };
  }
  const anthropic = await fakeAnthropic({
    reply: (request) => {
      const at = request.text.lastIndexOf("[tool approval]");
      if (at >= 0) return { text: `Resumed: ${request.text.slice(at).split("\n")[1] ?? ""}` };
      if (Object.keys(request.results).length) return { text: `The tool said: ${Object.values(request.results)[0]}` };
      return request.tools.includes(`mcp__fake__${tool}`) ? { tool: { name: `mcp__fake__${tool}`, input } } : { text: "Noted." };
    },
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
  return { server, answer: await owner(server), fake: await addFake(t, server.api), extra: { harness: "claude-agent", model: "anthropic/claude-haiku-4-5" }, content: `Use the ${tool} tool.` };
}
const PARK_HARNESSES = ["pi", ...(existsSync("/usr/bin/setpriv") ? ["claude-agent"] : [])];

/** Whether run `runId`'s journal holds the end a stop writes (an agentrun.end, stopped). */
async function stopEnded(server, runId) {
  const row = await server.store.runs.get(runId);
  const { entries } = await journalRecords(server.store.journal({ runId, runner: "reader", epoch: row.epoch, until: 0, from: row.state }), BACKGROUND_CONTEXT);
  return entries.some((entry) => entry.kind === "agentrun.end" && (entry.data?.state === "stopped" || entry.data?.outcome === "stopped"));
}

/** Run `runId` of `harness` after its stop was accepted: followed until its journal holds the stop's end (bounded, failing
 *  by name), then read with nothing pending. A stop is a command the run's runner applies, so it has ended only once that
 *  end is written; what status word a stopped run then reads (cancelled, or input_required as main's stop left it) is
 *  not this test's. */
async function stoppedRun(server, runId, harness) {
  for (let i = 0; !(await stopEnded(server, runId)); i++) {
    assert.ok(i < 600, `${harness}: the stopped run's journal never held the stop's end (agentrun.end, stopped)`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const read = await follow(server.api, runId, ["input_required", "completed", "failed", "cancelled"], { deadlineMs: 60_000 }).catch((error) => assert.fail(`${harness}: the stopped run never settled: ${error.message}`));
  assert.equal((await server.api("GET", `/runs/${runId}`)).body.pending, null, `${harness}: nothing pending once stopped`);
  return read;
}

/** A repeat allow of a call the stop withdrew: refused (409) in main's words (runs.ts approve). */
async function refusedAsWithdrawn(answer, runId, approvalId, harness) {
  assert.deepEqual(await answer.refused(runId, approvalId, { decision: "allow" }), [409, `The tool call ${approvalId} was already withdrawn when its run was stopped.`], `${harness}: a later allow`);
}

test("a person's message while an MCP call is parked declines it with their words: the run resumes with the refusal, the row reads Declined by your message, a later allow is 409, and the server saw nothing; on pi and claude-agent", { timeout: 300_000 }, async (t) => {
  const said = "use the cached sum instead";
  for (const harness of PARK_HARNESSES) {
    const { server, answer, fake, extra, content } = await parkingServer(t, harness);
    const { api } = server;
    const runId = await started(api, `declined-${harness}`, ["mcp:fake/add"], content, { extra });
    const pending = await parked(api, runId);
    const sent = await api("POST", `/runs/${runId}/messages`, { content: said });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 150_000 });
    // pi's model reads the refusal as the call's own result; the CLI's session is resumed with main's message.
    const head = harness === "pi" ? "The tool said" : "Resumed";
    assert.match(await answerOf(api, runId) ?? "", new RegExp(`^${head}: The user denied this mcp:fake/add call\\. It was not run: nothing was sent and nothing was charged\\. Reason: ${said}`), harness);
    assert.match(rows.find((row) => row.kind === "tool_approval_requested")?.summary ?? "", /^Declined by your message: mcp:fake\/add /, harness);
    assert.equal(await answer(runId, pending.id, { decision: "allow" }), 409, `${harness}: a later allow`);
    assert.equal(calls(fake).length, 0, `${harness}: the server saw nothing`);
  }
});

test("a stop while an MCP call is parked withdraws it: no pending approval, the row reads Withdrawn, a later allow is 409, and the server saw nothing; on pi and claude-agent", { timeout: 300_000 }, async (t) => {
  for (const harness of PARK_HARNESSES) {
    const { server, answer, fake, extra, content } = await parkingServer(t, harness);
    const { api } = server;
    const runId = await started(api, `stopped-${harness}`, ["mcp:fake/add"], content, { extra });
    const pending = await parked(api, runId);
    const stop = await api("POST", `/runs/${runId}/stop`, {});
    assert.deepEqual([stop.status, stop.body.stopped], [200, true], JSON.stringify(stop.body));
    // The stop is the run's runner's to apply: once its end is written, nothing is pending.
    const { rows } = await stoppedRun(server, runId, harness);
    assert.match(rows.find((row) => row.kind === "tool_approval_requested")?.summary ?? "", /^Withdrawn when the run was stopped: /, harness);
    await refusedAsWithdrawn(answer, runId, pending.id, harness);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(calls(fake).length, 0, `${harness}: the server saw nothing`);
  }
});

test("a person's cancel of a run parked on an MCP call ends it cancelled: nothing pending, the call withdrawn and never sent, a later allow refused", { timeout: 120_000 }, async (t) => {
  const { server, answer, fake, extra, content } = await parkingServer(t, "pi");
  const { api } = server;
  const runId = await started(api, "cancelled-pi", ["mcp:fake/add"], content, { extra });
  const pending = await parked(api, runId);
  const cancel = await api("POST", `/runs/${runId}/cancel`, {});
  assert.deepEqual([cancel.status, cancel.body.cancel_requested], [202, true], JSON.stringify(cancel.body));
  const { rows } = await follow(api, runId, ["cancelled"], { deadlineMs: 60_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([view.status, view.state, view.pending], ["cancelled", "idle", null]);
  assert.ok(rows.some((row) => row.kind === "tool_approval_requested" && /^Withdrawn when the run was /.test(row.summary ?? "")), "the call reads withdrawn");
  assert.equal((await answer.refused(runId, pending.id, { decision: "allow" }))[0], 409, "a later allow");
  assert.equal(calls(fake).length, 0, "the server saw nothing");
});

test("a person's cancel of a run parked on an MCP call reads its call withdrawn when the run was cancelled, and a later allow is refused so (main's words)", { timeout: 120_000, skip: "a cancel's withdrawal is written as a stop's (decision withdrawn, not canceled)" }, async (t) => {
  const { server, answer, extra, content } = await parkingServer(t, "pi");
  const { api } = server;
  const runId = await started(api, "cancelled-words-pi", ["mcp:fake/add"], content, { extra });
  const pending = await parked(api, runId);
  assert.equal((await api("POST", `/runs/${runId}/cancel`, {})).status, 202);
  const { rows } = await follow(api, runId, ["cancelled"], { deadlineMs: 60_000 });
  assert.match(rows.find((row) => row.kind === "tool_approval_requested")?.summary ?? "", /^Withdrawn when the run was cancelled: mcp:fake\/add /);
  assert.deepEqual(await answer.refused(runId, pending.id, { decision: "allow" }), [409, `The tool call ${pending.id} was already canceled with its run.`]);
});

test("a person's stop of a run parked on an MCP call leaves it input_required and idle with nothing pending, its end's outcome stopped (main's stop)", { timeout: 120_000, skip: "route-1: reopen-stopped (base round 116)" }, async (t) => {
  const { server, answer, fake, extra, content } = await parkingServer(t, "pi");
  const { api } = server;
  const runId = await started(api, "stopped-literal-pi", ["mcp:fake/add"], content, { extra });
  const pending = await parked(api, runId);
  const stop = await api("POST", `/runs/${runId}/stop`, {});
  assert.deepEqual([stop.status, stop.body.stopped], [200, true], JSON.stringify(stop.body));
  const { rows } = await stoppedRun(server, runId, "pi");
  // The run's row keeps its stopped state, with the outcome a person's stop gives it; the view reads as main's stop left it.
  const row = await server.store.runs.get(runId);
  assert.deepEqual([row.state, row.outcome], ["stopped", "stopped"], "the run's row");
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([view.status, view.state, view.pending], ["input_required", "idle", null]);
  assert.match(rows.find((one) => one.kind === "tool_approval_requested")?.summary ?? "", /^Withdrawn when the run was stopped: mcp:fake\/add /);
  await refusedAsWithdrawn(answer, runId, pending.id, "pi");
  assert.equal(calls(fake).length, 0, "the server saw nothing");
});

test("a stop while an approved MCP call runs cuts it at the server: the fake sees its request closed and never finishes the work, nothing resumes, the row reads Withdrawn, and a later allow is 409; on pi and claude-agent", { timeout: 300_000 }, async (t) => {
  for (const harness of PARK_HARNESSES) {
    const { server, answer, fake, extra, content } = await parkingServer(t, harness, { tool: "slow_write", input: { line: "never", seconds: 20 } });
    // The work the slow tool does, told apart from a call cut before it: done only when its wait ran out.
    fake.tools.slow_write = { ...fake.tools.slow_write, run: async ({ line, seconds }, extra) => {
      await new Promise((done) => {
        const timer = setTimeout(done, seconds * 1000);
        extra?.signal?.addEventListener("abort", () => (clearTimeout(timer), done()));
      });
      fake.log.push({ method: extra?.signal?.aborted ? "abandoned" : "finished", tool: "slow_write" });
      return { content: [{ type: "text", text: `wrote ${line}` }] };
    } };
    const { api } = server;
    const runId = await started(api, `cut-${harness}`, ["mcp:fake/slow_write"], content, { extra });
    const pending = await parked(api, runId);
    assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
    for (let i = 0; calls(fake, "slow_write").length === 0; i++) {
      assert.ok(i < 600, `${harness}: the approved call reaches the server`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const stop = await api("POST", `/runs/${runId}/stop`, {});
    assert.deepEqual([stop.status, stop.body.stopped], [200, true], JSON.stringify(stop.body));
    for (let i = 0; !fake.log.some((entry) => entry.method === "closed" && entry.closed === "slow_write"); i++) {
      assert.ok(i < 100, `${harness}: the server sees the call's request closed: ${JSON.stringify(fake.log.map((entry) => entry.method))}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const { rows } = await stoppedRun(server, runId, harness);
    assert.match(rows.find((row) => row.kind === "tool_approval_requested")?.summary ?? "", /^Withdrawn when the run was stopped: /, harness);
    assert.ok(!rows.some((row) => row.kind === "user_message" && (row.text ?? "").includes("[tool approval]")), `${harness}: nothing resumed`);
    assert.ok(!rows.some((row) => `${row.text ?? ""} ${row.tool_result_preview ?? ""}`.includes("wrote never")), `${harness}: no result of the work reached the run`);
    await refusedAsWithdrawn(answer, runId, pending.id, harness);
    assert.equal(calls(fake, "slow_write").length, 1, `${harness}: sent once`);
    assert.ok(!fake.log.some((entry) => entry.method === "finished"), `${harness}: the work never finished while the run waited`);
  }
});
