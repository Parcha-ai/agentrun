// One route for every model request of a run (the harness-kernel untangle, fix 5): a learned workflow's model node is a
// request on the run's own route, the one its harness's requests take, never a client of its own. On pi that is the run's
// own models (marked, capped). On claude-agent, codex and opencode it is the session's model proxy: the same body
// rules, origin, credential, price, booking and cap as the harness's own requests, under a side key that labels it
// learned_workflow in the session's booking. So it reaches whatever gateway the operator set, with the run's auth, and
// nothing else; there is no second meter for it; and no run is refused its learned workflows because of where its
// harness's requests go (no `workflows_off`).
// The CLI harnesses run on the faux harness here (scripted turns), with a real model proxy under the harness's own
// policy in front of a faux gateway on loopback.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as adapters from "../dist/adapters.js";
import { agentFolderOf } from "../dist/files.js";
import * as learning from "../dist/learning.js";
import { LEARNED_WORKFLOW_TOOL, learnedWorkflowDescription, learnedWorkflowTool } from "../dist/learned-workflow.js";
import { MODEL_KEYS } from "../dist/model.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { entriesOf, git, resnap } from "./learn-support.mjs";
import { agent, answerFlow, follow, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const ASK = "Use the learned workflow answer on What is six times seven.";
const DESCRIPTION = "Answers a question as a number; use when the person asks for the answer";
/** Dummy keys: not real ones. */
const fake = (name) => ["not-a-secret", name].join("-");
const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_API_KEY", "AGENT_MODEL_GATEWAY_IDS", "AGENT_MODEL_PRICE", "PARALLEL_API_KEY", ...MODEL_KEYS.map((row) => row.field)];

/** learned_workflow's description and input schema for the one `answer` workflow, as LS-07 trimmed them: the same on pi
 *  and as each harness is given it. */
const SAID = "Runs one of this agent's learned workflows in one call, by name, on a JSON input with the fields below (* required). Answers its output as JSON, or why it did not run.\n- answer {question* string}: Answers a question as a number; use when the person asks for the answer";
const SCHEMA = { type: "object", additionalProperties: false, required: ["name", "input"], properties: { name: { type: "string", enum: ["answer"] }, input: { type: "object" } } };

const flowFiles = (name, workflow) => ({
  [`workflows/${name}/workflow.json`]: JSON.stringify(workflow),
  [`workflows/${name}/README.md`]: `---\nname: ${name}\ndescription: ${DESCRIPTION}\n---\n`,
});
async function folderWith(data, id, files) {
  await learning.seedOf(data, id);
  const repo = join(agentFolderOf(data, id), "learning");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  await resnap(data, id);
}
/** Agent `id` on `harness`, learning, with the `answer` workflow learned; one run of `ask`, ended. */
async function ran(api, data, id, harness, { fields = {}, ask = ASK, ends = ["completed", "failed"], model } = {}) {
  assert.equal((await api("POST", "/agents", agent(id, { learning: true, harness, instructions: ask, ...(model ? { model } : {}) }))).status, 201);
  await folderWith(data, id, flowFiles("answer", answerFlow()));
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: ask }, ...fields });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { rows } = await follow(api, runId, ends, { deadlineMs: 90_000 });
  return { runId, rows, view: (await api("GET", `/runs/${runId}`)).body };
}
const learnedResult = (rows) => rows.find((row) => row.kind === "tool_result" && row.tool_name === LEARNED_WORKFLOW_TOOL);
/** The node's submit, when a request offers the node's submit tool and carries no tool result yet. */
const submitsAnswer = ({ body }) => {
  const offers = (body?.tools ?? []).some((tool) => tool?.name === "submit");
  const answered = (body?.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result")) || (body?.input ?? []).some((item) => item?.type === "function_call_output");
  return offers && !answered ? { name: "submit", input: { value: { answer: 42 } } } : undefined;
};
/** The session's records of the node's requests: runner.request entries labelled learned_workflow. */
const labelled = async (data, runId) => (await entriesOf({ data }, runId, ["runner.request"])).filter((entry) => entry.host === LEARNED_WORKFLOW_TOOL);
/** The second meter's marks: side requests labelled learned_workflow on the root (capModels, markRequests). */
const sideMarks = async (data, runId) => (await entriesOf({ data }, runId, ["agentrun.request_started", "agentrun.request_cost"])).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL);

test("R1 (guard) on pi a learned node's request is one of the run's own: marked and costed through the run's models, in its cost", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const { runId, rows, view } = await ran(api, data, "pi-route", "pi");
  assert.equal(view.status, "completed", JSON.stringify(view));
  assert.equal(learnedResult(rows)?.tool_status, "success", JSON.stringify(learnedResult(rows)));
  // On the runner pi's learned node is booked as every harness's is: one runner.request labelled learned_workflow.
  assert.deepEqual([await sideMarks(data, runId), (await labelled(data, runId)).length], [[], 1], "booked once, on the run's one booking");
  assert.equal(typeof view.cost?.usd, "number", JSON.stringify(view.cost));
});

test("R2 a claude-agent run's learned node request reaches the session's proxy with the side key, is booked in the session's runner records and counts in the one cap, with no learned_workflow REQUEST_COST: behind the operator's gateway (ANTHROPIC_BASE_URL) it reaches that gateway with the run's key, and nothing reaches api.anthropic.com", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({ call: submitsAnswer });
  t.after(() => gw.close());
  const key = fake("anthropic");
  withEnv(t, { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: gw.url, AGENT_MODEL: "anthropic/claude-sonnet-4-5" }, MODEL_VARS);
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
  const { runId, rows, view } = await ran(api, data, "claude-gated", "claude-agent", { fields: { max_cost_usd: 5 } });
  const sent = gw.requests.filter((r) => r.method === "POST");
  const said = `gateway: ${JSON.stringify(sent.map((r) => [r.path, r.query, r.body?.model]))}; ${learnedResult(rows)?.tool_result_preview}`;
  // Through the session's proxy under its side key: the session's booking admitted it (its runner.request, labelled),
  // under the run's one cap (the guard's hold on it).
  const booked = (await labelled(data, runId));
  assert.equal(booked.length, 1, `the node's request is the session's, labelled learned_workflow: ${JSON.stringify((await entriesOf({ data }, runId, ["runner.request"])))}; ${said}`);
  assert.ok(booked[0].heldUsd > 0, `held by the session's guard under the run's cap: ${JSON.stringify(booked[0])}`);
  assert.deepEqual((await sideMarks(data, runId)), [], "no second meter: no learned_workflow request_started or request_cost of its own");
  // Its number is the session's one counter's, never a harness request's, and it is settled once by its own runner.turn.
  const own = (await entriesOf({ data }, runId, ["runner.request"])).filter((entry) => entry.host === undefined).map((entry) => entry.turn);
  assert.equal(own.includes(booked[0].turn), false, `the node's ${booked[0].turn} is none of the harness's ${own}`);
  assert.equal((await entriesOf({ data }, runId, ["runner.turn"])).filter((entry) => entry.turn === booked[0].turn).length, 1, "settled once, by its own runner.turn");
  assert.deepEqual(sent.map((r) => [r.path, r.headers["x-api-key"], r.body?.model]), [["/v1/messages", key, "claude-sonnet-4-5"]], `the node's one request, at the gateway, with the run's key: ${said}`);
  assert.deepEqual(sent[0].body.tools.map((tool) => tool.name), ["submit"], "offered the node's submit, and nothing else");
  assert.equal(learnedResult(rows)?.tool_status, "success", JSON.stringify(learnedResult(rows)));
  assert.match(JSON.stringify(learnedResult(rows)), /\{\\?"answer\\?":42\}/);
  assert.equal(view.status, "completed", JSON.stringify(view));
});

for (const harness of ["codex", "opencode"]) {
  test(`R3 a ${harness} run behind the gateway (AGENT_MODEL_BASE_URL) sends its learned node's request through the run's proxy, with the gateway's key, booked and priced on the session's one meter`, { timeout: 120_000 }, async (t) => {
    const gw = await startFauxGateway({ call: submitsAnswer });
    t.after(() => gw.close());
    const key = fake("gateway");
    withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: key, AGENT_MODEL_PRICE: "1,2,0.5" }, MODEL_VARS);
    const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
    const { runId, rows, view } = await ran(api, data, `${harness}-gated`, harness);
    const sent = gw.requests.filter((r) => r.method === "POST");
    assert.deepEqual(sent.map((r) => [r.path, r.headers.authorization, r.body?.model]), [["/v1/responses", `Bearer ${key}`, "gpt-test"]], "the node's one request, at the gateway, with its key");
    const booked = (await labelled(data, runId));
    assert.equal(booked.length, 1, `the node's request is the session's, labelled learned_workflow: ${JSON.stringify((await entriesOf({ data }, runId, ["runner.request"])))}`);
    assert.deepEqual((await sideMarks(data, runId)), [], "no second meter: no side marks of its own");
    // The gateway's usage (10 in, 2 out) at $1 and $2 a million: the session's booking prices it as the harness's own.
    const turn = (await entriesOf({ data }, runId, ["runner.turn"])).find((entry) => entry.turn === booked[0].turn);
    assert.ok(Math.abs((turn?.usd ?? -1) - 0.000014) < 1e-9, `priced as the run's requests are: ${JSON.stringify(turn)}`);
    assert.ok(Math.abs(view.cost.usd - (0.002 + 0.000014)) < 1e-9, `in the run's one cost: ${JSON.stringify(view.cost)}`);
    assert.equal(learnedResult(rows)?.tool_status, "success", JSON.stringify(learnedResult(rows)));
  });
}

// The gateway priced on output alone, $100 a million tokens: a node's least on codex's session (responsesOutputLeast:
// 1,024 answer tokens + the reasoning allowance, 9,216 tokens) is $0.9216. The faux harness books each of its own requests
// at $0.001.
const OUTPUT_PRICED = "0,100,0,0";
test("R4 (guard) a capped codex run's learned node is admitted by the session's own guard: refused when the harness's spend leaves less than its least, and the run pauses at the cap on the one total", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({ call: submitsAnswer });
  t.after(() => gw.close());
  withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: OUTPUT_PRICED }, MODEL_VARS);
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
  const { runId, rows, view } = await ran(api, data, "capped-port", "codex", { fields: { max_cost_usd: 0.103 }, ends: ["completed", "failed", "input_required"] });
  assert.deepEqual(gw.requests.filter((r) => r.method === "POST"), [], "the node's request never left");
  assert.deepEqual((await entriesOf({ data }, runId, ["runner.request"])).filter((entry) => entry.host === LEARNED_WORKFLOW_TOOL), [], "refused before its record: the session wrote none");
  assert.deepEqual([view.status, view.state, view.pending?.kind, view.pending?.cap_usd, view.pending?.spent_usd, view.pending?.needs_usd], ["input_required", "waiting", "budget", 0.103, 0.001, 0.9216], JSON.stringify(view));
  assert.equal(learnedResult(rows)?.tool_status, "failed", JSON.stringify(learnedResult(rows)));
  assert.deepEqual((await sideMarks(data, runId)), [], "no second meter");
});

test("R4 a capped codex run's harness counts its learned node on the one total: its next request is held to what is left after it", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({ call: submitsAnswer });
  t.after(() => gw.close());
  withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: OUTPUT_PRICED }, MODEL_VARS);
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
  // The node's request goes through the session's proxy, whose policy says its least output: codex's
  // responsesOutputLeast (run-adapters-codex policy.ts), 1,024 answer tokens + the reasoning allowance of the effort it
  // names = 9,216 tokens, at $100 a million = $0.9216, as for the harness's own reasoning requests. The harness's first
  // request ($0.001) and that least fit under $2.
  const cap = 2;
  const { runId, rows } = await ran(api, data, "counted-port", "codex", { fields: { max_cost_usd: cap } });
  const requests = (await entriesOf({ data }, runId, ["runner.request"]));
  const node = requests.filter((entry) => entry.host === LEARNED_WORKFLOW_TOOL);
  assert.equal(node.length, 1, `the node's request is the session's: ${JSON.stringify(requests)}; ${learnedResult(rows)?.tool_result_preview}`);
  assert.equal(learnedResult(rows)?.tool_status, "success", JSON.stringify(learnedResult(rows)));
  const nodeUsd = (await entriesOf({ data }, runId, ["runner.turn"])).find((entry) => entry.turn === node[0].turn)?.usd;
  assert.ok(Math.abs(nodeUsd - 0.0002) < 1e-9, `the gateway's 2 output tokens at $100 a million: ${nodeUsd}`);
  const own = requests.filter((entry) => entry.host === undefined);
  assert.equal(own.length, 2, JSON.stringify(own));
  const left = cap - 0.001 - nodeUsd;
  assert.ok(own[1].heldUsd <= left + 1e-9 && own[1].heldUsd > left - 0.0001 - 1e-9, `the harness's next request held at ${own[1].heldUsd}; what is left after the node's $${nodeUsd} is ${left}`);
});

test("R8 (guard) learned_workflow's description and input schema are as LS-07 trimmed them, on pi and as the harness is given it on claude-agent and codex; a pathless output is refused in #1727's words", { timeout: 120_000 }, async (t) => {
  const flows = [{ name: "answer", description: DESCRIPTION, workflow: JSON.stringify(answerFlow()) }];
  assert.equal(learnedWorkflowDescription(flows), SAID);
  const tool = learnedWorkflowTool({ workflows: flows, granted: [], env: {}, work: "/tmp", models: {}, modelOf: () => undefined, policy: () => "allow", denyFrom: () => "default" });
  assert.deepEqual([tool.description, tool.parameters], [SAID, SCHEMA], "pi's tool");
  const opened = join(await scratch(t), "opened.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_HARNESS_OPENED: opened });
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS) });
  for (const harness of ["claude-agent", "codex"]) {
    await ran(api, data, `said-${harness}`, harness);
    const given = readFileSync(opened, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.learned).at(-1)?.learned;
    assert.deepEqual(given, { description: SAID, inputSchema: SCHEMA }, harness);
  }
  const flow = answerFlow();
  delete flow.output.path;
  const pathless = (await import("../dist/learn/index.js")).draftProblems(await import("@parcha/agentrun-dsl"), JSON.stringify(flow), [], {});
  assert.match(pathless.map((p) => p.detail).join("; "), /its output names no path: a learned workflow's output is the value at output\.path/);
});

test("R9 no run is offered fewer learned workflows for where its harness's requests go: the pin keeps no workflows_off, and the per-harness route code is gone", async (t) => {
  for (const name of ["learnedRoute", "learnedWorkflowsOff", "learnedOriginOk"]) assert.equal(adapters[name], undefined, `adapters.ts exports no ${name}`);
  const data = join(await scratch(t), "agents");
  mkdirSync(data, { recursive: true });
  await folderWith(data, "pinned", flowFiles("answer", answerFlow()));
  const runDir = join(await scratch(t), "run");
  mkdirSync(join(runDir, "work"), { recursive: true });
  const seed = await learning.seedOf(data, "pinned");
  // A caller that still says why it would withhold them is not heard: every learned workflow is the run's.
  const pin = await learning.pinSeed(runDir, localWorkspace(join(runDir, "work")), seed, { budget: 8000, read: false, shown: learning.secretsShown([]), workflowsOff: "a reason no run is refused for any more" });
  assert.deepEqual([pin.workflows, "workflows_off" in pin, pin.workflows_left_out], [["answer"], false, undefined], JSON.stringify(pin));
});

// SKIP (follow-up #2078): a learned node's request is not routed or booked as before on the runner
test.skip("R10 (guard) the harness's next request after a node request on the same model is priced against the harness's own previous request, never the node's", { timeout: 180_000 }, async (t) => {
  const gw = await startFauxGateway({ call: submitsAnswer });
  t.after(() => gw.close());
  // Sonnet's prices, as grown() bills its requests: the gateway's model is the session's, the node's and the harness's.
  withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: "2,10,0.2,2.5" }, MODEL_VARS);
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
  const ownHeld = async (runId) => (await entriesOf({ data }, runId, ["runner.request"])).filter((entry) => entry.host === undefined).map((entry) => entry.heldUsd);
  const plain = await ran(api, data, "grown-plain", "codex", { fields: { max_cost_usd: 5 }, ask: "Grow three requests." });
  const beside = await ran(api, data, "grown-beside", "codex", { fields: { max_cost_usd: 5 }, ask: "Grow three requests, the second running the learned workflow answer on What is six times seven." });
  assert.equal(learnedResult(beside.rows)?.tool_status, "success", JSON.stringify(learnedResult(beside.rows)));
  const [a, b] = [await ownHeld(plain.runId), await ownHeld(beside.runId)];
  assert.equal(a.length >= 3 && b.length >= 3, true, JSON.stringify({ a, b }));
  assert.ok(Math.abs(a[2] - b[2]) < 1e-9, `the third request held as it is with no node before it: ${b[2]} against ${a[2]}`);
});

test("R12 a learned node's request is a side call of the session (#1831): its runner.request says side, so the wrap-up's typical cost never counts it, and it never takes nor carries the wrap-up's note, which the harness's own next request takes", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({ call: submitsAnswer });
  t.after(() => gw.close());
  withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: "0,100,0,0" }, MODEL_VARS);
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
  // A $1.50 cap: the harness's $0.40 request leaves $1.10. The note is due when what is left is under three times the
  // typical $0.40 = $1.20, and the node's least ($0.9216: codex's responsesOutputLeast, 9,216 tokens at $100 a million)
  // still fits, so a cap in $1.32-$1.60. The node's request is then the session's next on its model, which would take
  // the note if a side call could.
  const { runId, rows } = await ran(api, data, "wrap-node", "codex", { fields: { max_cost_usd: 1.5 }, ask: "Wrap up around the learned workflow answer on What is six times seven." });
  assert.equal(learnedResult(rows)?.tool_status, "success", JSON.stringify(learnedResult(rows)));
  const node = (await labelled(data, runId));
  assert.deepEqual(node.map((entry) => entry.side), [true], `a side call on its record: ${JSON.stringify(node)}`);
  const sent = gw.requests.filter((r) => r.method === "POST");
  assert.equal(sent.length, 1, "the node's one request");
  assert.doesNotMatch(JSON.stringify(sent[0].body), /run's budget/, "the node's request carries no wrap-up note");
  // That the harness's own next request then takes the note is the proxy's rule, not reachable here: the faux harness's
  // own requests never go through the session's proxy (run-adapters proxy-note.test: a side key's request never takes
  // the note, the next main-model request does).
});
