// A learned workflow's call node that names an MCP tool (`via: "tool"`, `tool: "mcp:<server>/<tool>"`) runs it through the
// run's own MCP, as the harness's own call of it runs (host-calls.ts: the loop's wrapped tool), under the same gate and
// booked on the run's one ledger: allowed, it runs once and its price is the run's tool cost; denied, the workflow is
// refused before any node runs and the server sees nothing; set to ask, the learned_workflow call itself asks once, the run
// parks, and the owner's allow runs it once; a stop while it runs cuts the call at the server. pi, on the faux model.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, call, clientOwnerSession, follow, retried, serve as serveOf, withEnv } from "./support.mjs";
import { agentFolderOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import { LEARNED_ASK_CARD_BYTES, learnedAskFits, learnedAskShown, LEARNED_WORKFLOW_TOOL } from "../dist/learned-workflow.js";
import { git, resnap } from "./learn-support.mjs";

const FAUX_MCP = new URL("./fixtures/faux-mcp.mjs", import.meta.url).pathname;
const FAUX_CALLS = new URL("./fixtures/faux-calls.mjs", import.meta.url).pathname;
const TOKEN = `not-a-secret-${"learned-mcp-bearer-0123"}`;
const json = { "content-type": "application/json" };
const serve = (t) => (withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }), serveOf(t, { faux: FAUX_MCP, accounts: true, openSetup: true }));
const calls = (fake, tool) => fake.log.filter((entry) => entry.method === "tools/call" && (tool === undefined || entry.tool === tool));

/** A learned workflow of one call node on MCP tool `tool` with `args`, its result `as` the output. */
const mcpFlow = (name, tool, args, input, out = { type: "number" }) => ({
  v: 2, name,
  schemas: { In: { type: "object", properties: Object.fromEntries(Object.entries(input).map(([key, type]) => [key, { type }])), required: Object.keys(input) }, Out: out },
  input: { schemaId: "In" }, output: { schemaId: "Out", path: "result" },
  root: { node: "call", label: "mcp", via: "tool", tool, args, out: "Out", as: "result", deadline_s: 60 },
});
const ADD_FLOW = mcpFlow("add-two", "mcp:fake/add", { a: "{a}", b: "{b}" }, { a: "number", b: "number" });
const WRITE_FLOW = mcpFlow("write-slowly", "mcp:fake/slow_write", { line: "{line}", seconds: 20 }, { line: "string" }, { type: "object" });
const RUN_ADD = `Call ${LEARNED_WORKFLOW_TOOL} with ${JSON.stringify({ name: "add-two", input: { a: 2, b: 3 } })}`;
const RUN_WRITE = `Call ${LEARNED_WORKFLOW_TOOL} with ${JSON.stringify({ name: "write-slowly", input: { line: "never" } })}`;

/** The fake MCP server saved as `fake`, with `prices`. */
async function addFake(t, api, prices) {
  const fake = await startFakeMcp({ token: TOKEN });
  t.after(() => fake.close());
  const saved = await api("PUT", "/settings/mcp-servers/fake", { url: fake.url, auth: { type: "bearer", token: TOKEN }, ...(prices ? { prices } : {}) });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return fake;
}

/** The owner's answer to approval `approvalId` of run `runId`, as the console sends it: its status. */
async function owner(server) {
  const { cookie, origin } = await clientOwnerSession(server);
  return async (runId, approvalId, body) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${approvalId}`, headers: { ...json, cookie, origin }, body })).status;
}

/** Agent `id`, learning, granted `tools`, with `flows` learned in its folder; one run of it asking `content`. */
async function learnedRun(server, id, tools, flows, content, run = {}) {
  const { api, data } = server;
  assert.equal((await retried(api)("POST", "/agents",agent(id, { learning: true, tools }))).status, 201);
  await seedOf(data, id);
  const repo = join(agentFolderOf(data, id), "learning");
  const files = Object.fromEntries(flows.flatMap((flow) => [[`workflows/${flow.name}/workflow.json`, JSON.stringify(flow)], [`workflows/${flow.name}/README.md`, `---\nname: ${flow.name}\ndescription: Runs ${flow.name}\n---\n`]]));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  await resnap(data, id);
  const started = await retried(api)("POST", `/agents/${id}/runs`,{ input: { content }, ...run });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return started.body.run_id;
}

const learnedResult = (rows) => rows.find((row) => row.kind === "tool_result" && row.tool_name === LEARNED_WORKFLOW_TOOL);
const answerOf = async (api, runId) => (await api("GET", `/runs/${runId}`)).body.result?.final_answer;

test("an MCP node allowed runs once through the run's MCP, and its price is booked as the run's tool cost", { timeout: 120_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const fake = await addFake(t, api, { add: 0.05 });
  assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "allow" } })).status, 200);
  const runId = await learnedRun(server, "adder", ["mcp:fake/add"], [ADD_FLOW], RUN_ADD, { max_cost_usd: 1 });
  const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(await answerOf(api, runId), "The tool said: 5", JSON.stringify(learnedResult(rows)));
  assert.equal(calls(fake, "add").length, 1, "sent once");
  assert.equal((await api("GET", `/runs/${runId}`)).body.cost?.usd, 0.05, "the faux model is free: the run's cost is the MCP node's");
  const tools = (await api("GET", "/usage?group_by=meter")).body.lines.find((line) => line.meter === "tools");
  assert.equal(tools?.usd, 0.05, JSON.stringify(tools));
});

test("an MCP node set to deny refuses the whole learned_workflow call at the gate, in the gate's words, before any node runs; the server sees nothing", { timeout: 120_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/add": { permission: "deny" } })).status, 200);
  const runId = await learnedRun(server, "denied", ["mcp:fake/add"], [ADD_FLOW], RUN_ADD);
  const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  const result = learnedResult(rows);
  const said = `${result?.text ?? ""} ${result?.tool_result_preview ?? ""}`;
  assert.match(said, /The learned workflow add-two was not run: .*mcp:fake\/add.*deny/s, JSON.stringify(result));
  assert.equal(calls(fake).length, 0, "the server saw nothing");
  assert.equal((await api("GET", `/runs/${runId}`)).body.pending ?? null, null, "never asked: a deny is never put to a person");
});

test("an MCP node is held to the tool's argument pins with the arguments the workflow resolved: one outside the pin is refused in the pin's words, nothing sent", { timeout: 120_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const fake = await addFake(t, api);
  // add allowed only with a = 9; the workflow sends a = 2.
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/add": { permission: "allow", pin: { a: 9 } } })).status, 200);
  const runId = await learnedRun(server, "pinned", ["mcp:fake/add"], [ADD_FLOW], RUN_ADD);
  const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  const result = learnedResult(rows);
  assert.match(`${result?.text ?? ""} ${result?.tool_result_preview ?? ""}`, /add-two failed: .*\ba\b/s, JSON.stringify(result));
  assert.equal(calls(fake).length, 0, "the server saw nothing");
});

test("on a server with accounts off no one can approve: a workflow whose MCP node is set to ask is refused at once in the gate's words, never parked, nothing sent", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serveOf(t, { faux: FAUX_MCP, accounts: false, openSetup: false });
  const { api } = server;
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" } })).status, 200);
  const runId = await learnedRun(server, "unattended", ["mcp:fake/add"], [ADD_FLOW], RUN_ADD);
  const { last, rows } = await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", `refused at once, never parked on an approval no one can give: ${last.status}`);
  const result = learnedResult(rows);
  assert.match(`${result?.text ?? ""} ${result?.tool_result_preview ?? ""}`, /The learned workflow add-two was not run: .*accounts off/s, JSON.stringify(result));
  assert.equal(calls(fake).length, 0, "nothing was sent");
});

test("a workflow with an MCP node set to deny is refused without asking, even when learned_workflow itself is set to ask", { timeout: 120_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "ask" }, "mcp:fake/add": { permission: "deny" } })).status, 200);
  const runId = await learnedRun(server, "denied-ask", ["mcp:fake/add"], [ADD_FLOW], RUN_ADD);
  const { last, rows } = await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 90_000 });
  assert.equal(last.status, "completed", `refused, never put to a person: ${last.status}`);
  assert.match(`${learnedResult(rows)?.text ?? ""} ${learnedResult(rows)?.tool_result_preview ?? ""}`, /was not run: .*mcp:fake\/add.*deny/s);
  assert.equal(calls(fake).length, 0, "nothing was sent");
});

test("a learned call's card leads with its MCP fields and names every ask-gated tool; a list past the card's bound doesn't fit, so the gate refuses the call rather than hide a tool", () => {
  const few = ["mcp:fake/add", "mcp:fake/paid"];
  assert.deepEqual(Object.keys(learnedAskShown(few)), ["mcp_arguments", "mcp_calls"], "the arguments' note first, then the tools");
  assert.deepEqual(learnedAskShown(few).mcp_calls, few);
  assert.equal(learnedAskFits(few), true);
  // Enough tools that their names alone pass the card's preview bound.
  const many = Array.from({ length: 120 }, (_, i) => `mcp:server-${i}/tool-with-a-long-name-${i}`);
  assert.ok(Buffer.byteLength(JSON.stringify(learnedAskShown(many))) > LEARNED_ASK_CARD_BYTES);
  assert.equal(learnedAskFits(many), false, "too many to show: refused, never approved unseen");
});

/** Run `runId`'s pending approval of `tool`, once it waits on one: a call other than `after`'s (an earlier card the run
 *  read before its answer was taken). */
async function pendingOf(api, runId, tool, after) {
  for (let i = 0; ; i++) {
    const view = (await api("GET", `/runs/${runId}`)).body;
    const pending = view.pending;
    if (view.status === "input_required" && pending?.kind === "approval" && pending.call_id !== after?.call_id) {
      assert.equal(pending.tool, tool, JSON.stringify(pending));
      return pending;
    }
    assert.ok(i < 900 && !["completed", "failed", "cancelled"].includes(view.status), `the run waits on an approval of ${tool}: ${JSON.stringify({ status: view.status, pending })}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("an MCP node set to ask asks once for the learned_workflow call, its card naming every MCP tool it may call and that their arguments are decided as it runs; the owner's allow runs it once", { timeout: 150_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" } })).status, 200);
  const runId = await learnedRun(server, "asker", ["mcp:fake/add"], [ADD_FLOW], RUN_ADD);
  const pending = await pendingOf(api, runId, LEARNED_WORKFLOW_TOOL);
  // The person sees what they approve: the workflow's input, the MCP tool it may call, and that its arguments are the
  // workflow's to decide.
  const card = JSON.stringify(pending.args_preview ?? pending);
  assert.match(card, /add-two/, card);
  assert.match(card, /mcp:fake\/add/, card);
  assert.match(card, /decided by the workflow while it runs/, card);
  assert.equal(calls(fake).length, 0, "nothing sent while it waits");
  assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.match(await answerOf(api, runId) ?? "", /5/);
  assert.equal(calls(fake, "add").length, 1, "run once, after the allow");
});

test("the up-front card names every MCP tool set to ask that the workflow can call, never one it may call without asking, and says their arguments are decided while it runs", { timeout: 150_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/slow_write": { permission: "allow" } })).status, 200);
  // Three MCP nodes in turn: add and paid are set to ask (no setting), slow_write is allowed.
  const node = (label, tool, args, as) => ({ node: "call", label, via: "tool", tool, args, out: "Any", as, deadline_s: 60 });
  const THREE = {
    v: 2, name: "three-calls",
    schemas: { In: { type: "object", properties: { a: { type: "number" }, b: { type: "number" }, note: { type: "string" } }, required: ["a", "b"] }, Any: {} },
    input: { schemaId: "In" }, output: { schemaId: "Any", path: "sum" },
    root: { node: "chain", steps: [node("add", "mcp:fake/add", { a: "{a}", b: "{b}" }, "sum"), node("look", "mcp:fake/paid", { query: "ada" }, "found"), node("write", "mcp:fake/slow_write", { line: "x", seconds: 0 }, "wrote")] },
  };
  // An input past the card's preview bound: the card still names the tools, ahead of it.
  const runId = await learnedRun(server, "three", ["mcp:fake/add", "mcp:fake/paid", "mcp:fake/slow_write"], [THREE], `Call ${LEARNED_WORKFLOW_TOOL} with ${JSON.stringify({ name: "three-calls", input: { a: 2, b: 3, note: "n".repeat(3000) } })}`);
  const pending = await pendingOf(api, runId, LEARNED_WORKFLOW_TOOL);
  const card = pending.args_preview ?? "";
  assert.equal(typeof card, "string", JSON.stringify(pending));
  for (const asked of ["mcp:fake/add", "mcp:fake/paid"]) assert.ok(card.includes(asked), `the card names ${asked}: ${card}`);
  assert.ok(!card.includes("mcp:fake/slow_write"), `the card names no tool the workflow may call without asking: ${card}`);
  assert.ok(card.includes("decided by the workflow while it runs"), `the card says the arguments are decided while it runs: ${card}`);
  assert.equal(calls(fake).length, 0, "nothing sent while it waits");
  assert.equal(await answer(runId, pending.id, { decision: "deny" }), 204);
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(calls(fake).length, 0, "denied: nothing sent");
});

test("a learned_workflow call whose card covers a destructive MCP tool is marked destructive: an allow without confirm_destructive is 422 and nothing is sent; with it, the node runs once. A card of no destructive tool is not marked", { timeout: 150_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" } })).status, 200);
  // Two MCP nodes in turn, both set to ask (no setting): add, which the server marks read-only, and delete_thing, which it
  // marks destructive. The one allow of the learned_workflow call lets both run, so it takes the second confirm.
  const node = (label, tool, args, as) => ({ node: "call", label, via: "tool", tool, args, out: "Any", as, deadline_s: 60 });
  const WIPE = {
    v: 2, name: "add-then-delete",
    schemas: { In: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, Any: {} },
    input: { schemaId: "In" }, output: { schemaId: "Any", path: "sum" },
    root: { node: "chain", steps: [node("add", "mcp:fake/add", { a: "{a}", b: "{b}" }, "sum"), node("delete", "mcp:fake/delete_thing", { id: "x" }, "gone")] },
  };
  const runId = await learnedRun(server, "wiper", ["mcp:fake/add", "mcp:fake/delete_thing"], [WIPE], `Call ${LEARNED_WORKFLOW_TOOL} with ${JSON.stringify({ name: "add-then-delete", input: { a: 2, b: 3 } })}`);
  const pending = await pendingOf(api, runId, LEARNED_WORKFLOW_TOOL);
  assert.ok((pending.args_preview ?? "").includes("mcp:fake/delete_thing"), JSON.stringify(pending));
  assert.equal(pending.destructive, true, `the card covers a destructive tool, so the call is marked: ${JSON.stringify(pending)}`);
  assert.equal(await answer(runId, pending.id, { decision: "allow" }), 422, "one click is not enough");
  assert.equal((await api("GET", `/runs/${runId}`)).body.pending?.id, pending.id, "the call keeps waiting");
  assert.equal(calls(fake).length, 0, "nothing sent");
  assert.equal(await answer(runId, pending.id, { decision: "allow", confirm_destructive: true }), 204);
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.deepEqual([calls(fake, "add").length, calls(fake, "delete_thing").length], [1, 1], "confirmed: each node ran once");
  // A card that covers no destructive tool takes one click, as before.
  const plain = await learnedRun(server, "adder", ["mcp:fake/add"], [ADD_FLOW], RUN_ADD);
  const one = await pendingOf(api, plain, LEARNED_WORKFLOW_TOOL);
  assert.equal(one.destructive, undefined, JSON.stringify(one));
});

test("an allow of a learned_workflow call covers that call only: the same workflow called again in the run asks again, and so does the harness's own call of the same MCP tool", { timeout: 240_000 }, async (t) => {
  // One run, three calls in turn (faux-calls.mjs): the workflow, the workflow again, then the MCP tool itself.
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serveOf(t, { faux: FAUX_CALLS, accounts: true, openSetup: true });
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" } })).status, 200);
  const learned = [LEARNED_WORKFLOW_TOOL, { name: "add-two", input: { a: 2, b: 3 } }];
  const runId = await learnedRun(server, "scoped", ["mcp:fake/add"], [ADD_FLOW], `Calls ${JSON.stringify([learned, learned, ["mcp__fake__add", { a: 2, b: 3 }]])}`);
  const first = await pendingOf(api, runId, LEARNED_WORKFLOW_TOOL);
  assert.equal(await answer(runId, first.id, { decision: "allow" }), 204);
  // The second call asks on a card of its own.
  const second = await pendingOf(api, runId, LEARNED_WORKFLOW_TOOL, first);
  assert.equal(calls(fake, "add").length, 1, "only the approved call ran; the earlier allow sent nothing for the second");
  assert.equal(await answer(runId, second.id, { decision: "deny" }), 204);
  await pendingOf(api, runId, "mcp:fake/add", second);
  assert.equal(calls(fake, "add").length, 1, "the harness's own call of the tool waits for its own approval");
});

test("an approval covers exactly the MCP tools its card named: a tool set to ask after the card was shown is refused, and nothing is sent", { timeout: 150_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/slow_write": { permission: "allow" } })).status, 200);
  // Two MCP nodes in turn: add is set to ask (no setting), slow_write is allowed.
  const node = (label, tool, args, as) => ({ node: "call", label, via: "tool", tool, args, out: "Any", as, deadline_s: 60 });
  const TWO = {
    v: 2, name: "two-calls",
    schemas: { In: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, Any: {} },
    input: { schemaId: "In" }, output: { schemaId: "Any", path: "sum" },
    root: { node: "chain", steps: [node("add", "mcp:fake/add", { a: "{a}", b: "{b}" }, "sum"), node("write", "mcp:fake/slow_write", { line: "x", seconds: 0 }, "wrote")] },
  };
  const runId = await learnedRun(server, "unshown", ["mcp:fake/add", "mcp:fake/slow_write"], [TWO], `Call ${LEARNED_WORKFLOW_TOOL} with ${JSON.stringify({ name: "two-calls", input: { a: 2, b: 3 } })}`);
  const pending = await pendingOf(api, runId, LEARNED_WORKFLOW_TOOL);
  const card = pending.args_preview ?? "";
  assert.ok(card.includes("mcp:fake/add") && !card.includes("mcp:fake/slow_write"), `the card names add alone: ${card}`);
  // slow_write is set to ask after the card was shown: the person never saw it, so their allow never covers it.
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/slow_write": { permission: "ask" } })).status, 200);
  assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
  const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  const result = learnedResult(rows);
  const said = `${result?.text ?? ""} ${result?.tool_result_preview ?? ""}`;
  assert.match(said, /two-calls was not run: .*mcp:fake\/slow_write/s, JSON.stringify(result));
  assert.equal(calls(fake).length, 0, "refused before any node ran: nothing sent, add included");
});

test("a stop while an MCP node's call runs cuts it at the server: the work never finishes and nothing of it reaches the run", { timeout: 150_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const fake = await addFake(t, api);
  fake.tools.slow_write = { ...fake.tools.slow_write, run: async ({ line, seconds }, extra) => {
    await new Promise((done) => {
      const timer = setTimeout(done, seconds * 1000);
      extra?.signal?.addEventListener("abort", () => (clearTimeout(timer), done()));
    });
    fake.log.push({ method: extra?.signal?.aborted ? "abandoned" : "finished", tool: "slow_write" });
    return { content: [{ type: "text", text: `wrote ${line}` }] };
  } };
  assert.equal((await api("PUT", "/settings/tools", { "mcp:fake/*": { permission: "allow" } })).status, 200);
  const runId = await learnedRun(server, "writer", ["mcp:fake/slow_write"], [WRITE_FLOW], RUN_WRITE);
  // The event the stop waits on: the server has the call's request.
  for (let i = 0; calls(fake, "slow_write").length === 0; i++) {
    assert.ok(i < 900, "the MCP node's call reaches the server");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const stop = await api("POST", `/runs/${runId}/stop`, {});
  assert.deepEqual([stop.status, stop.body.stopped], [200, true], JSON.stringify(stop.body));
  for (let i = 0; !fake.log.some((entry) => entry.method === "closed" && entry.closed === "slow_write"); i++) {
    assert.ok(i < 300, `the server sees the call's request closed: ${JSON.stringify(fake.log.map((entry) => entry.method))}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const { rows } = await follow(api, runId, ["input_required", "completed", "failed", "cancelled"], { deadlineMs: 60_000 });
  assert.ok(!rows.some((row) => `${row.text ?? ""} ${row.tool_result_preview ?? ""}`.includes("wrote never")), "no result of the work reached the run");
  assert.equal(calls(fake, "slow_write").length, 1, "sent once");
  assert.ok(!fake.log.some((entry) => entry.method === "finished"), "the work never finished");
});
