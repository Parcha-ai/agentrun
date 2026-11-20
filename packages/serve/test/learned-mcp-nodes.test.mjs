// A learned workflow's call node that names an MCP tool (`via: "tool"`, `tool: "mcp:<server>/<tool>"`) runs it as a call
// nested in the learned_workflow call (NestedCalls), as the harness's own call of it runs, under the same gate and booked
// on the run's one ledger: allowed, it runs once and its price is the run's tool cost; denied, the workflow is refused
// before any node runs and the server sees nothing; set to ask, the learned_workflow call itself asks once, the run parks,
// and the owner's allow runs it once; a stop while it runs cuts the call at the server. pi, on the faux model.
import assert from "node:assert/strict";
import { promoteChecked } from "./learned-workflow-seed-support.mjs";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { startFakeMcp } from "./fixtures/fake-mcp-server.mjs";
import { agent, call, clientOwnerSession, follow, retried, runRecordOf, scratch, serve as serveOf, withEnv } from "./support.mjs";
import { NODE_REQUESTS_ENV } from "./fixtures/faux-learned-node.mjs";
import { agentFolderOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import { learnedApprovedTools, learnedAskShown, LEARNED_WORKFLOW_TOOL } from "../dist/learned-workflow.js";
import { ARGS_PREVIEW_BYTES } from "../dist/tool-gate.js";
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
  return async (runId, approvalId, body) => (await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${encodeURIComponent(approvalId)}`, headers: { ...json, cookie, origin }, body })).status;
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
  // Execution permissions and recovery are rechecked even for a previously promoted revision.
  await promoteChecked(server.store.settings, id, flows.map((workflow) => ({ name: workflow.name, workflow })));
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

test("a learned call's card leads with its MCP fields and names each ask-gated action with its arguments' shape; past the card's bound it names only those shown whole, so an approval never covers one unseen", () => {
  const few = [{ tool: "mcp:fake/add", args: { a: "{a}", b: "{b}" } }, { tool: "mcp:fake/paid", args: { query: "{q}" } }];
  assert.deepEqual(Object.keys(learnedAskShown(few)), ["mcp_arguments", "mcp_calls"], "the arguments' note first, then the actions");
  assert.deepEqual(learnedAskShown(few).mcp_calls, few);
  assert.deepEqual([...learnedApprovedTools(learnedAskShown(few))], ["mcp:fake/add", "mcp:fake/paid"], "an allow covers the tools it named");
  // Enough actions that their names alone pass the card's preview bound: the card names a whole first part of them, within
  // the bound, and its allow covers those and no other (each other one asks on its own as it runs).
  const many = Array.from({ length: 120 }, (_, i) => ({ tool: `mcp:server-${i}/tool-with-a-long-name-${i}`, args: { id: "{id}" } }));
  const shown = learnedAskShown(many);
  assert.ok(Buffer.byteLength(JSON.stringify(shown)) <= ARGS_PREVIEW_BYTES - 128, "within the card's preview bound");
  assert.ok(shown.mcp_calls.length > 0 && shown.mcp_calls.length < many.length, `a first part: ${shown.mcp_calls.length}`);
  assert.deepEqual(shown.mcp_calls, many.slice(0, shown.mcp_calls.length));
  assert.ok(!learnedApprovedTools(shown).has(many.at(-1).tool), "one past the bound is never covered");
  // A model-written card field reads as no tool: only `{ tool }` entries count.
  assert.equal(learnedApprovedTools({ mcp_calls: ["mcp:fake/add"] }).size, 0);
});

test("a tool the card cannot show every action of is not on the card at all: its approval covers by tool, so naming one of its actions would pass the unseen others", () => {
  const first = { tool: "mcp:fake/add", args: { a: "{a}", b: 1 } };
  const later = { tool: "mcp:fake/add", args: { a: "{a}", b: "{b}" } };
  const filler = Array.from({ length: 120 }, (_, i) => ({ tool: `mcp:server-${i}/tool-with-a-long-name-${i}`, args: { id: "{id}" } }));
  const shown = learnedAskShown([first, ...filler, later]);
  assert.ok(shown.mcp_calls.length > 0, "the card shows a first part of the filler");
  assert.ok(!learnedApprovedTools(shown).has("mcp:fake/add"), `add's later action is past the cut, so add is not named: ${JSON.stringify(shown.mcp_calls.slice(0, 2))}`);
  assert.ok(shown.mcp_calls.every((action) => action.tool !== "mcp:fake/add"), "nor any action of it");
  // A tool whose every action is shown stays named.
  assert.ok(learnedApprovedTools(learnedAskShown([first, later])).has("mcp:fake/add"));
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

test("an MCP node set to ask asks once for the learned_workflow call, its card naming every MCP tool it may call and that their arguments are filled in as it runs; the owner's allow runs it once", { timeout: 150_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" } })).status, 200);
  const runId = await learnedRun(server, "asker", ["mcp:fake/add"], [ADD_FLOW], RUN_ADD);
  const pending = await pendingOf(api, runId, LEARNED_WORKFLOW_TOOL);
  // The person sees what they approve: the workflow's input, the MCP tool it may call, and that its arguments are filled
  // in by the workflow as it runs.
  const card = JSON.stringify(pending.args_preview ?? pending);
  assert.match(card, /add-two/, card);
  assert.match(card, /mcp:fake\/add/, card);
  assert.match(card, /filled in while the workflow runs/, card);
  assert.equal(calls(fake).length, 0, "nothing sent while it waits");
  assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.match(await answerOf(api, runId) ?? "", /5/);
  assert.equal(calls(fake, "add").length, 1, "run once, after the allow");
});

test("the up-front card names every MCP tool set to ask that the workflow can call, never one it may call without asking, and says their arguments are filled in while it runs", { timeout: 150_000 }, async (t) => {
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
  assert.ok(card.includes("filled in while the workflow runs"), `the card says the arguments are filled in while it runs: ${card}`);
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

// One card per learned_workflow call, its MCP nodes the call's nested calls (NestedCalls): the card names every MCP action
// set to ask with the shape of its arguments; the one allow lets those run with no second ask; an action the card did not
// name parks the run as a call of its own; a deny refuses before any node runs; each node is booked on the run's one
// ledger and held to its cap.
const step = (label, tool, args, as) => ({ node: "call", label, via: "tool", tool, args, out: "Any", as, deadline_s: 60 });
const chain = (name, steps, output) => ({
  v: 2, name,
  schemas: { In: { type: "object", properties: { a: { type: "number" }, b: { type: "number" }, q: { type: "string" } }, required: ["a", "b"] }, Any: {} },
  input: { schemaId: "In" }, output: { schemaId: "Any", path: output },
  root: { node: "chain", steps },
});
const runOf = (name, input) => `Call ${LEARNED_WORKFLOW_TOOL} with ${JSON.stringify({ name, input })}`;
const ADD_THEN_PAID = chain("add-then-look", [step("add", "mcp:fake/add", { a: "{a}", b: "{b}" }, "sum"), step("look", "mcp:fake/paid", { query: "{q}" }, "found")], "sum");

test("the card names every MCP action set to ask with the shape of its arguments, and none the workflow may run without asking", { timeout: 150_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/slow_write": { permission: "allow" } })).status, 200);
  const flow = chain("three-actions", [...ADD_THEN_PAID.root.steps, step("write", "mcp:fake/slow_write", { line: "{q}", seconds: 0 }, "wrote")], "sum");
  const runId = await learnedRun(server, "shapes", ["mcp:fake/add", "mcp:fake/paid", "mcp:fake/slow_write"], [flow], runOf("three-actions", { a: 2, b: 3, q: "ada" }));
  const pending = await pendingOf(api, runId, LEARNED_WORKFLOW_TOOL);
  const card = pending.args_preview ?? "";
  for (const action of [{ tool: "mcp:fake/add", args: { a: "{a}", b: "{b}" } }, { tool: "mcp:fake/paid", args: { query: "{q}" } }]) {
    assert.ok(card.includes(JSON.stringify(action)), `the card names ${action.tool} with its arguments' shape: ${card}`);
  }
  assert.ok(!card.includes("mcp:fake/slow_write"), `allowed, slow_write is not on the card: ${card}`);
  assert.equal(calls(fake).length, 0, "nothing sent while it waits");
});

test("one allow of the card runs every MCP action it named, each once, with no second ask", { timeout: 150_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" } })).status, 200);
  const runId = await learnedRun(server, "both", ["mcp:fake/add", "mcp:fake/paid"], [ADD_THEN_PAID], runOf("add-then-look", { a: 2, b: 3, q: "ada" }));
  const pending = await pendingOf(api, runId, LEARNED_WORKFLOW_TOOL);
  assert.equal(await answer(runId, pending.id, { decision: "allow" }), 204);
  // A second ask would leave the run waiting: it completes on the one allow.
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed");
  assert.match(await answerOf(api, runId) ?? "", /5/);
  assert.deepEqual([calls(fake, "add").length, calls(fake, "paid").length], [1, 1], "each named action ran once");
});

test("each check of a polled MCP node is a call of its own: the server is asked again at every check, never answered the first check's record", { timeout: 150_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/paid": { permission: "allow" } })).status, 200);
  const polled = { ...step("look", "mcp:fake/paid", { query: "{q}" }, "found"), out: "Paid", deadline_s: 1, poll: { until: { predicate: "field_equals", path: "text", value: "never" }, interval_s: 0.2, deadline_s: 2 } };
  const base = chain("poll-look", [polled], "found");
  const flow = { ...base, schemas: { ...base.schemas, Paid: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } };
  const runId = await learnedRun(server, "poller", ["mcp:fake/paid"], [flow], runOf("poll-look", { a: 0, b: 0, q: "ada" }));
  const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.match(`${learnedResult(rows)?.text ?? ""} ${learnedResult(rows)?.tool_result_preview ?? ""}`, /poll/i, "the poll ran out, never met");
  assert.ok(calls(fake, "paid").length >= 2, `every check reached the server: ${calls(fake, "paid").length}`);
});

test("an MCP action the approved card did not name asks on its own: the run parks on it as a call nested in the workflow's, and its allow runs it once while the actions already run are never sent again", { timeout: 200_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/slow_write": { permission: "allow" } })).status, 200);
  const flow = chain("add-then-write", [step("add", "mcp:fake/add", { a: "{a}", b: "{b}" }, "sum"), step("write", "mcp:fake/slow_write", { line: "x", seconds: 0 }, "wrote")], "sum");
  const runId = await learnedRun(server, "off-card", ["mcp:fake/add", "mcp:fake/slow_write"], [flow], runOf("add-then-write", { a: 2, b: 3 }));
  const card = await pendingOf(api, runId, LEARNED_WORKFLOW_TOOL);
  assert.ok(!(card.args_preview ?? "").includes("mcp:fake/slow_write"), card.args_preview);
  // slow_write is set to ask after the card was shown: the allow never covers it.
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/slow_write": { permission: "ask" } })).status, 200);
  assert.equal(await answer(runId, card.id, { decision: "allow" }), 204);
  const nested = await pendingOf(api, runId, "mcp:fake/slow_write", card);
  assert.match(nested.args_preview ?? "", /"line":"x"/, `the nested card shows the call's own arguments: ${JSON.stringify(nested)}`);
  assert.deepEqual([calls(fake, "add").length, calls(fake, "slow_write").length], [1, 0], "the named action ran; the unnamed one waits unsent");
  assert.equal(await answer(runId, nested.id, { decision: "allow" }), 204);
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed");
  assert.deepEqual([calls(fake, "add").length, calls(fake, "slow_write").length], [1, 1], "each sent once: the earlier one answered from its record");
});

test("a deny of any of its MCP actions refuses the workflow before any node runs, an allowed node before it included", { timeout: 120_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/add": { permission: "allow" }, "mcp:fake/delete_thing": { permission: "deny" } })).status, 200);
  const flow = chain("add-then-delete", [step("add", "mcp:fake/add", { a: "{a}", b: "{b}" }, "sum"), step("delete", "mcp:fake/delete_thing", { id: "x" }, "gone")], "sum");
  const runId = await learnedRun(server, "deny-later", ["mcp:fake/add", "mcp:fake/delete_thing"], [flow], runOf("add-then-delete", { a: 2, b: 3 }));
  const { rows } = await follow(api, runId, ["completed", "failed", "input_required"], { deadlineMs: 90_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed", "refused, never put to a person");
  assert.match(`${learnedResult(rows)?.text ?? ""} ${learnedResult(rows)?.tool_result_preview ?? ""}`, /add-then-delete was not run: .*mcp:fake\/delete_thing.*deny/s);
  assert.equal(calls(fake).length, 0, "nothing sent, the allowed add included");
});

test("each MCP node is booked on the run's one ledger and held to its cap: the first runs and is charged, the next the cap has no room for is refused unsent and the run waits on a raise", { timeout: 150_000 }, async (t) => {
  const server = await serve(t);
  const { api } = server;
  const fake = await addFake(t, api, { add: 0.05, paid: 0.05 });
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/*": { permission: "allow" } })).status, 200);
  const runId = await learnedRun(server, "capped", ["mcp:fake/add", "mcp:fake/paid"], [ADD_THEN_PAID], runOf("add-then-look", { a: 2, b: 3, q: "ada" }), { max_cost_usd: 0.08 });
  await follow(api, runId, ["input_required"], { deadlineMs: 90_000 });
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([view.pending?.kind, view.pending?.cap_usd, view.pending?.needs_usd], ["budget", 0.08, 0.05], JSON.stringify(view.pending));
  assert.deepEqual([calls(fake, "add").length, calls(fake, "paid").length], [1, 0], "the second is refused unsent");
  assert.equal(view.cost?.usd, 0.05, "the first node's price is the run's cost");
});

// A learned_workflow call runs again from its start after a park or a crash (it nests calls). Its model node's answer
// is the first run's (NestedCalls.memo), taken from the record: the rerun never asks the node's model again, so the
// node is asked and booked on the run's ledger once. The node's model is a priced faux (faux-learned-node.mjs).
const FAUX_NODE = new URL("./fixtures/faux-learned-node.mjs", import.meta.url).pathname;
const CRASHABLE = { leaseMs: 1_500, renewEveryMs: 300, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
const titleStep = { node: "extract", label: "title", instructions: "Name the note.", out: "Title", as: "title" };
/** A learned workflow of a model node (the note's title), then `steps`: its output the title. */
const titled = (name, steps) => ({ ...chain(name, [titleStep, ...steps], "title"), schemas: { ...chain(name, []).schemas, Title: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } } });

/** The server on the priced faux, each request of a learned workflow's model node noted (`asked`: how many so far). */
async function nodeServe(t, options = {}) {
  const file = join(await scratch(t), "node-requests.jsonl");
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64"), [NODE_REQUESTS_ENV]: file });
  const server = await serveOf(t, { faux: FAUX_NODE, accounts: true, openSetup: true, ...options });
  return { server, asked: () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0) };
}

/** The run's ledger rows of the learned_workflow call's model requests: each runner.request booked under its label, and
 *  the runner.turn that settled it, across every session of the run. */
async function nodeBookings(server, runId) {
  const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { createRegistry, Harness } = await import("@earendil-works/pi-durable");
  const { journalSessions } = await import("../dist/runner/sessions.js");
  const row = await server.store.runs.get(runId);
  const harness = await Harness.open(server.store.journal({ runId, runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), { models: createModels(), registry: createRegistry(), onReport: () => {} }, ctx);
  try {
    const sessions = journalSessions(harness, ctx, server.store);
    const requests = [];
    const turns = [];
    for (const key of await sessions.keys()) {
      const records = await sessions.read(key);
      for (const record of records) {
        if (record.kind !== "runner.request" || record.data?.host !== LEARNED_WORKFLOW_TOOL) continue;
        requests.push(record.data);
        turns.push(...records.filter((other) => other.kind === "runner.turn" && other.data?.turn === record.data.turn).map((other) => other.data));
      }
    }
    return { requests, turns };
  } finally {
    await harness.close(ctx);
  }
}

test("a model node that ran before an action off the card parked the run is asked and booked once: the call's rerun after the allow takes its first answer", { timeout: 200_000 }, async (t) => {
  const { server, asked } = await nodeServe(t);
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/slow_write": { permission: "allow" } })).status, 200);
  const flow = titled("title-add-write", [step("add", "mcp:fake/add", { a: "{a}", b: "{b}" }, "sum"), step("write", "mcp:fake/slow_write", { line: "x", seconds: 0 }, "wrote")]);
  const runId = await learnedRun(server, "node-once", ["mcp:fake/add", "mcp:fake/slow_write"], [flow], runOf("title-add-write", { a: 2, b: 3 }));
  const card = await pendingOf(api, runId, LEARNED_WORKFLOW_TOOL);
  assert.equal(asked(), 0, "no node runs before the card is answered");
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/slow_write": { permission: "ask" } })).status, 200);
  assert.equal(await answer(runId, card.id, { decision: "allow" }), 204);
  const nested = await pendingOf(api, runId, "mcp:fake/slow_write", card);
  const first = asked();
  assert.ok(first > 0, "the model node ran before the off-card action parked the run");
  assert.equal(await answer(runId, nested.id, { decision: "allow" }), 204);
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed");
  assert.equal(asked(), first, "the rerun never asked the node's model again");
  const after = await nodeBookings(server, runId);
  assert.equal(after.requests.length, first, `the node's requests are booked once: ${JSON.stringify(after.requests)}`);
  assert.equal(after.turns.length, first, `and settled once: ${JSON.stringify(after.turns)}`);
  assert.deepEqual([calls(fake, "add").length, calls(fake, "slow_write").length], [1, 1], "each MCP action sent once");
});

test("a model node that ran before a crash cut the call is asked and booked once: the call's rerun on the next runner takes its first answer", { timeout: 240_000 }, async (t) => {
  const { server, asked } = await nodeServe(t, { runnerTiming: CRASHABLE });
  const { api, data } = server;
  const fake = await addFake(t, api);
  assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/*": { permission: "allow" } })).status, 200);
  const flow = titled("title-then-wait", [step("write", "mcp:fake/slow_write", { line: "x", seconds: 30 }, "wrote")]);
  const runId = await learnedRun(server, "node-crash", ["mcp:fake/slow_write"], [flow], runOf("title-then-wait", { a: 2, b: 3 }));
  for (let i = 0; calls(fake, "slow_write").length === 0; i++) {
    assert.ok(i < 900, "the workflow reaches its MCP node, after its model node");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const first = asked();
  assert.ok(first > 0, "the model node ran before the crash");
  const held = runRecordOf(data, runId);
  await server.crashRunner();
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 150_000 });
  assert.ok(runRecordOf(data, runId).epoch > held.epoch, "another runner took the run up");
  const { rows } = await follow(api, runId, ["completed", "failed"]);
  assert.ok(rows.filter((row) => row.kind === "tool_result" && row.tool_name === LEARNED_WORKFLOW_TOOL).length >= 1, "the call answered on the next runner");
  assert.equal(asked(), first, "the rerun never asked the node's model again");
  const booked = await nodeBookings(server, runId);
  assert.equal(booked.requests.length, first, `the node's requests are booked once: ${JSON.stringify(booked.requests)}`);
  assert.equal(calls(fake, "slow_write").length, 1, "the cut MCP call is never sent again");
});

test("an approved card covers its own call only: an action an earlier call's card named, asked in a later call of the same workflow whose card did not name it, parks on a card of its own", { timeout: 240_000 }, async (t) => {
  // One run, three calls in turn (faux-calls.mjs): the workflow, the harness's own call of `paid`, the workflow again.
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") });
  const server = await serveOf(t, { faux: FAUX_CALLS, accounts: true, openSetup: true });
  const { api } = server;
  const answer = await owner(server);
  const fake = await addFake(t, api);
  const settings = async (write, add) => assert.equal((await api("PUT", "/settings/tools", { [LEARNED_WORKFLOW_TOOL]: { permission: "allow" }, "mcp:fake/slow_write": { permission: write }, "mcp:fake/add": { permission: add } })).status, 200);
  await settings("allow", "ask");
  const flow = chain("write-then-add", [step("write", "mcp:fake/slow_write", { line: "x", seconds: 0 }, "wrote"), step("add", "mcp:fake/add", { a: "{a}", b: "{b}" }, "sum")], "sum");
  const learned = [LEARNED_WORKFLOW_TOOL, { name: "write-then-add", input: { a: 2, b: 3 } }];
  const runId = await learnedRun(server, "earlier-card", ["mcp:fake/add", "mcp:fake/slow_write", "mcp:fake/paid"], [flow], `Calls ${JSON.stringify([learned, ["mcp__fake__paid", { query: "x" }], learned])}`);
  const first = await pendingOf(api, runId, LEARNED_WORKFLOW_TOOL);
  assert.ok(first.args_preview.includes('"tool":"mcp:fake/add"') && !first.args_preview.includes("slow_write"), first.args_preview);
  assert.equal(await answer(runId, first.id, { decision: "allow" }), 204);
  const own = await pendingOf(api, runId, "mcp:fake/paid", first);
  assert.deepEqual([calls(fake, "slow_write").length, calls(fake, "add").length], [1, 1], "the first call ran whole on its card");
  // The second call's card is shown with add allowed and slow_write set to ask; add is set to ask again while it waits.
  await settings("ask", "allow");
  assert.equal(await answer(runId, own.id, { decision: "allow" }), 204);
  const second = await pendingOf(api, runId, LEARNED_WORKFLOW_TOOL, own);
  assert.ok(second.args_preview.includes('"tool":"mcp:fake/slow_write"') && !second.args_preview.includes("mcp:fake/add"), second.args_preview);
  await settings("ask", "ask");
  assert.equal(await answer(runId, second.id, { decision: "allow" }), 204);
  const nested = await pendingOf(api, runId, "mcp:fake/add", second);
  assert.ok(nested.call_id.startsWith(`${second.call_id}/`), `asked as a call nested in the second: ${JSON.stringify(nested)}`);
  assert.deepEqual([calls(fake, "slow_write").length, calls(fake, "add").length], [2, 1], "the earlier card passed nothing of the later call");
  assert.equal(await answer(runId, nested.id, { decision: "allow" }), 204);
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
  assert.equal(calls(fake, "add").length, 2, "its own allow runs it once");
});
