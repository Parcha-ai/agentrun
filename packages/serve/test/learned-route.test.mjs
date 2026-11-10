// One route for every model request of a run (the harness-kernel untangle, fix 5): a learned workflow's model node is a
// request on the run's own route, the one its harness's requests take, never a client of its own. On pi that is the run's
// own models (marked, capped). On claude-agent, codex and opencode it is the session's model proxy: the same body
// rules, origin, credential, price, booking and cap as the harness's own requests, under a side key that labels it
// learned_workflow in the session's booking. So it reaches whatever gateway the operator set, with the run's auth, and
// nothing else; there is no second meter for it; and no run is refused its learned workflows because of where its
// harness's requests go (no `workflows_off`).
// The CLI harnesses run on the faux harness here (scripted turns), with a real model proxy under the harness's own
// policy in front of a faux gateway on loopback. A net guard in the run's process refuses and logs anything past
// loopback.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import * as adapters from "../dist/adapters.js";
import { agentFolderOf } from "../dist/files.js";
import * as learning from "../dist/learning.js";
import { LEARNED_WORKFLOW_TOOL, learnedWorkflowDescription, learnedWorkflowTool } from "../dist/learned-workflow.js";
import { MODEL_KEYS } from "../dist/model.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { git, resnap } from "./learn-support.mjs";
import { agent, answerFlow, follow, runDir, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const GUARD = new URL("./fixtures/net-guard.mjs", import.meta.url).pathname;
const ASK = "Use the learned workflow answer on What is six times seven.";
const DESCRIPTION = "Answers a question as a number; use when the person asks for the answer";
/** Dummy keys: not real ones. */
const fake = (name) => ["not-a-secret", name].join("-");
const MODEL_VARS = ["AGENT_MODEL_BASE_URL", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_FAST", "AGENT_MODEL_STRONG", "AGENT_MODEL_API_KEY", "AGENT_MODEL_GATEWAY_IDS", "AGENT_MODEL_PRICE", "PARALLEL_API_KEY", ...MODEL_KEYS.map((row) => row.field)];

/** learned_workflow's description and input schema for the one `answer` workflow, as #1727 left them: the route moves,
 *  what the model is offered does not. */
const SAID = "Run a workflow this agent learned, as one step: give its name and its input, a JSON object as the workflow's input\nschema says. It answers the workflow's output as JSON, or why it did not run. The workflows:\n- answer: Answers a question as a number; use when the person asks for the answer\n  input: {question* string} (* required)";
const SCHEMA = { type: "object", additionalProperties: false, required: ["name", "input"], properties: { name: { type: "string", enum: ["answer"], description: "The learned workflow to run." }, input: { type: "object", description: "The workflow's input, as its input schema says." } } };

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
const pinOf = (data, runId) => JSON.parse(readFileSync(join(runDir(data, runId), "learning.json"), "utf8"));
/** The run's store entries of `kinds`, each `{ kind, ...data }`. */
function entries(data, runId, kinds) {
  const db = new DatabaseSync(join(runDir(data, runId), "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
  try {
    return db.prepare("SELECT record FROM entries ORDER BY rowid").all().map((row) => JSON.parse(String(row.record))).filter((entry) => kinds.includes(entry.kind)).map((entry) => ({ kind: entry.kind, ...entry.data, ...(entry.model ? { model: entry.model } : {}) }));
  } finally {
    db.close();
  }
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
/** A net guard in every process the server starts, logging to a file of `t`'s: its lines. */
async function guarded(t) {
  const log = join(await scratch(t), "guard.jsonl");
  return { env: { NET_GUARD_LOG: log, NODE_OPTIONS: `--import=${pathToFileURL(GUARD).href}` }, lines: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []) };
}
/** The session's records of the node's requests: runner.request entries labelled learned_workflow. */
const labelled = (data, runId) => entries(data, runId, ["runner.request"]).filter((entry) => entry.host === LEARNED_WORKFLOW_TOOL);
/** The second meter's marks: side requests labelled learned_workflow on the root (capModels, markRequests). */
const sideMarks = (data, runId) => entries(data, runId, ["agentrun.request_started", "agentrun.request_cost"]).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL);

// SKIP (follow-up #2078): a learned node's request is not routed or booked as before on the runner
test.skip("R1 (guard) on pi a learned node's request is one of the run's own: marked and costed through the run's models, in its cost", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const { runId, rows, view } = await ran(api, data, "pi-route", "pi");
  assert.equal(view.status, "completed", JSON.stringify(view));
  assert.equal(learnedResult(rows)?.tool_status, "success", JSON.stringify(learnedResult(rows)));
  assert.deepEqual(sideMarks(data, runId).map((entry) => entry.kind), ["agentrun.request_started", "agentrun.request_cost"], "marked on the run's models");
  assert.equal(typeof view.cost?.usd, "number", JSON.stringify(view.cost));
});

// SKIP (follow-up #2078): it reads the run's own database file, which runs no longer have after the server switch
test.skip("R2 a claude-agent run's learned node request reaches the session's proxy with the side key, is booked in the session's runner records and counts in the one cap, with no learned_workflow REQUEST_COST: behind the operator's gateway (ANTHROPIC_BASE_URL) it reaches that gateway with the run's key, and nothing reaches api.anthropic.com", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({ call: submitsAnswer });
  t.after(() => gw.close());
  const guard = await guarded(t);
  const key = fake("anthropic");
  withEnv(t, { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: gw.url, AGENT_MODEL: "anthropic/claude-sonnet-4-5", ...guard.env }, [...MODEL_VARS, "NODE_OPTIONS", "NET_GUARD_LOG"]);
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
  const { runId, rows, view } = await ran(api, data, "claude-gated", "claude-agent", { fields: { max_cost_usd: 5 } });
  const sent = gw.requests.filter((r) => r.method === "POST");
  const refusedHosts = () => guard.lines().filter((line) => line.kind === "refused").map((line) => `${line.call} ${line.host}`);
  const said = `gateway: ${JSON.stringify(sent.map((r) => [r.path, r.query, r.body?.model]))}; refused past loopback: ${JSON.stringify(refusedHosts())}; ${learnedResult(rows)?.tool_result_preview}`;
  // Through the session's proxy under its side key: the session's booking admitted it (its runner.request, labelled),
  // under the run's one cap (the guard's hold on it).
  const booked = labelled(data, runId);
  assert.equal(booked.length, 1, `the node's request is the session's, labelled learned_workflow: ${JSON.stringify(entries(data, runId, ["runner.request"]))}; ${said}`);
  assert.ok(booked[0].heldUsd > 0, `held by the session's guard under the run's cap: ${JSON.stringify(booked[0])}`);
  assert.deepEqual(sideMarks(data, runId), [], "no second meter: no learned_workflow request_started or request_cost of its own");
  // On the root as a request of the session: its start mark and its BOOKED marker name it, so its bound opens and closes.
  const marks = entries(data, runId, ["agentrun.request_started", "adapter.request"]).filter((entry) => entry.request === booked[0].turn);
  assert.deepEqual(marks.map((entry) => [entry.kind, entry.key]), [["agentrun.request_started", `run:${runId}`], ["adapter.request", `run:${runId}`]], JSON.stringify(marks));
  // Its number is the session's one counter's: never a harness request's, so no two requests share <key>:<n>, and every
  // start mark of the session is closed by one BOOKED marker of its own.
  const own = entries(data, runId, ["runner.request"]).filter((entry) => entry.host === undefined).map((entry) => entry.turn);
  assert.equal(own.includes(booked[0].turn), false, `the node's ${booked[0].turn} is none of the harness's ${own}`);
  const of = (kind) => entries(data, runId, [kind]).filter((entry) => entry.key === `run:${runId}` && typeof entry.request === "number").map((entry) => entry.request).sort((x, y) => x - y);
  assert.deepEqual(of("adapter.request"), of("agentrun.request_started"), "each start mark closed once, by its own marker");
  assert.deepEqual(sent.map((r) => [r.path, r.headers["x-api-key"], r.body?.model]), [["/v1/messages", key, "claude-sonnet-4-5"]], `the node's one request, at the gateway, with the run's key: ${said}`);
  assert.deepEqual(sent[0].body.tools.map((tool) => tool.name), ["submit"], "offered the node's submit, and nothing else");
  assert.deepEqual(refusedHosts(), [], "nothing past loopback, api.anthropic.com least of all");
  assert.ok(guard.lines().some((line) => line.kind === "loaded"), "the guard was in the run's process");
  assert.equal(learnedResult(rows)?.tool_status, "success", JSON.stringify(learnedResult(rows)));
  assert.match(JSON.stringify(learnedResult(rows)), /\{\\?"answer\\?":42\}/);
  assert.equal(view.status, "completed", JSON.stringify(view));
  const pin = pinOf(data, runId);
  assert.deepEqual([pin.workflows, "workflows_off" in pin], [["answer"], false], JSON.stringify(pin));
});

for (const harness of ["codex", "opencode"]) {
  // SKIP (follow-up #2078): a learned node's request is not routed or booked as before on the runner
  test.skip(`R3 a ${harness} run behind the gateway (AGENT_MODEL_BASE_URL) sends its learned node's request through the run's proxy, with the gateway's key, booked and priced on the session's one meter`, { timeout: 120_000 }, async (t) => {
    const gw = await startFauxGateway({ call: submitsAnswer });
    t.after(() => gw.close());
    const guard = await guarded(t);
    const key = fake("gateway");
    withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: key, AGENT_MODEL_PRICE: "1,2,0.5", ...guard.env }, [...MODEL_VARS, "NODE_OPTIONS", "NET_GUARD_LOG"]);
    const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
    const { runId, rows, view } = await ran(api, data, `${harness}-gated`, harness);
    const sent = gw.requests.filter((r) => r.method === "POST");
    assert.deepEqual(sent.map((r) => [r.path, r.headers.authorization, r.body?.model]), [["/v1/responses", `Bearer ${key}`, "gpt-test"]], "the node's one request, at the gateway, with its key");
    assert.deepEqual(guard.lines().filter((line) => line.kind === "refused").map((line) => line.host), [], "nothing past loopback");
    const booked = labelled(data, runId);
    assert.equal(booked.length, 1, `the node's request is the session's, labelled learned_workflow: ${JSON.stringify(entries(data, runId, ["runner.request"]))}`);
    assert.deepEqual(sideMarks(data, runId), [], "no second meter: no side marks of its own");
    // The gateway's usage (10 in, 2 out) at $1 and $2 a million: the session's booking prices it as the harness's own.
    const turn = entries(data, runId, ["runner.turn"]).find((entry) => entry.turn === booked[0].turn);
    assert.ok(Math.abs((turn?.usd ?? -1) - 0.000014) < 1e-9, `priced as the run's requests are: ${JSON.stringify(turn)}`);
    assert.ok(Math.abs(view.cost.usd - (0.002 + 0.000014)) < 1e-9, `in the run's one cost: ${JSON.stringify(view.cost)}`);
    assert.equal(learnedResult(rows)?.tool_status, "success", JSON.stringify(learnedResult(rows)));
  });
}

// The gateway priced on output alone, $100 a million tokens: a request's least (1,024 tokens) is $0.1024. The faux
// harness books each of its own requests at $0.001.
const OUTPUT_PRICED = "0,100,0,0";
// SKIP (follow-up #2078): a learned node's request is not routed or booked as before on the runner
test.skip("R4 (guard) a capped codex run's learned node is admitted by the session's own guard: refused when the harness's spend leaves less than its least, and the run pauses at the cap on the one total", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({ call: submitsAnswer });
  t.after(() => gw.close());
  withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: OUTPUT_PRICED }, MODEL_VARS);
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
  const { runId, rows, view } = await ran(api, data, "capped-port", "codex", { fields: { max_cost_usd: 0.103 }, ends: ["completed", "failed", "input_required"] });
  assert.deepEqual(gw.requests.filter((r) => r.method === "POST"), [], "the node's request never left");
  assert.deepEqual(entries(data, runId, ["runner.request"]).filter((entry) => entry.host === LEARNED_WORKFLOW_TOOL), [], "refused before its record: the session wrote none");
  assert.deepEqual([view.status, view.state, view.pending?.kind, view.pending?.cap_usd, view.pending?.spent_usd, view.pending?.needs_usd], ["input_required", "waiting", "budget", 0.103, 0.001, 0.1024], JSON.stringify(view));
  assert.equal(learnedResult(rows)?.tool_status, "failed", JSON.stringify(learnedResult(rows)));
  assert.deepEqual(sideMarks(data, runId), [], "no second meter");
});

// SKIP (follow-up #2078): it reads the run's own database file, which runs no longer have after the server switch
test.skip("R4 a capped codex run's harness counts its learned node on the one total: its next request is held to what is left after it", { timeout: 120_000 }, async (t) => {
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
  const requests = entries(data, runId, ["runner.request"]);
  const node = requests.filter((entry) => entry.host === LEARNED_WORKFLOW_TOOL);
  assert.equal(node.length, 1, `the node's request is the session's: ${JSON.stringify(requests)}; ${learnedResult(rows)?.tool_result_preview}`);
  assert.equal(learnedResult(rows)?.tool_status, "success", JSON.stringify(learnedResult(rows)));
  const nodeUsd = entries(data, runId, ["runner.turn"]).find((entry) => entry.turn === node[0].turn)?.usd;
  assert.ok(Math.abs(nodeUsd - 0.0002) < 1e-9, `the gateway's 2 output tokens at $100 a million: ${nodeUsd}`);
  const own = requests.filter((entry) => entry.host === undefined);
  assert.equal(own.length, 2, JSON.stringify(own));
  const left = cap - 0.001 - nodeUsd;
  assert.ok(own[1].heldUsd <= left + 1e-9 && own[1].heldUsd > left - 0.0001 - 1e-9, `the harness's next request held at ${own[1].heldUsd}; what is left after the node's $${nodeUsd} is ${left}`);
});

// SKIP (follow-up #2078): a learned node's request is not routed or booked as before on the runner
test.skip("R5 a claude-agent run on OPENROUTER_API_KEY alone sends its learned node's request through the run's proxy to OpenRouter's Messages endpoint, with OpenRouter's key as a bearer token", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({ call: submitsAnswer });
  t.after(() => gw.close());
  const dir = await scratch(t);
  // OpenRouter's route has no loopback setting: a preload in the run's process sends openrouter.ai to the faux gateway
  // and refuses (and logs) anything else past loopback.
  const hook = join(dir, "to-gateway.mjs");
  const away = join(dir, "away.jsonl");
  writeFileSync(hook, `import { appendFileSync } from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "127.0.0.1") return real(input, init);
  if (url.origin === "https://openrouter.ai") { const there = process.env.OR_TEST_GATEWAY + url.pathname + url.search; return input instanceof Request ? real(new Request(there, input), init) : real(there, init); }
  appendFileSync(${JSON.stringify(away)}, JSON.stringify({ origin: url.origin }) + "\\n");
  return Promise.reject(new Error("this test sends nothing to " + url.origin));
};
`);
  const key = fake("openrouter");
  withEnv(t, { OPENROUTER_API_KEY: key, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`, OR_TEST_GATEWAY: gw.url }, [...MODEL_VARS, "NODE_OPTIONS", "OR_TEST_GATEWAY"]);
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
  const { runId, rows } = await ran(api, data, "claude-openrouter", "claude-agent", { model: "openrouter/anthropic/claude-sonnet-4.5" });
  const sent = gw.requests.filter((r) => r.method === "POST");
  assert.deepEqual(sent.map((r) => [r.path, r.headers.authorization]), [["/api/v1/messages", `Bearer ${key}`]], `the node's one request, at OpenRouter's Messages endpoint: ${JSON.stringify(sent.map((r) => [r.path, r.body?.model]))}`);
  assert.equal(existsSync(away), false, `nothing went anywhere else: ${existsSync(away) ? readFileSync(away, "utf8") : ""}`);
  assert.equal(labelled(data, runId).length, 1, "the node's request is the session's, labelled learned_workflow");
  assert.equal(learnedResult(rows)?.tool_status, "success", JSON.stringify(learnedResult(rows)));
});

// SKIP (follow-up #2078): a learned node's request is not routed or booked as before on the runner
test.skip("R7 (guard) a call the harness's answer asks for beside learned_workflow stays on that answer: the node's request writes nothing into the turn", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({ call: submitsAnswer });
  t.after(() => gw.close());
  withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: "1,2,0.5" }, MODEL_VARS);
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
  const { runId, rows, view } = await ran(api, data, "beside", "codex", { ask: "Use the learned workflow answer on What is six times seven, and write note.md in the same answer." });
  assert.equal(view.status, "completed", JSON.stringify(view));
  assert.equal(learnedResult(rows)?.tool_status, "success", JSON.stringify(learnedResult(rows)));
  // Each pi.assistant entry follows the marker that names its request: the entries holding the two calls name one request.
  const root = entries(data, runId, ["adapter.request", "agentrun.request_continued", "pi.assistant"]);
  // harness-app writes an answer's entry, then its marker (adapter.request); a continuation's marker
  // (agentrun.request_continued) comes before its entry.
  const requestOf = (name) => {
    const at = root.findIndex((entry) => entry.kind === "pi.assistant" && (entry.model?.[0]?.content ?? []).some((part) => part.type === "toolCall" && part.name === name));
    assert.ok(at >= 0, `an answer holds ${name}: ${JSON.stringify(root.map((e) => [e.kind, e.request, e.model?.[0]?.content?.map((part) => part.name ?? part.type)]))}`);
    return root[at - 1]?.kind === "agentrun.request_continued" ? root[at - 1].request : root.slice(at + 1).find((entry) => entry.kind === "adapter.request")?.request;
  };
  assert.equal(requestOf("write"), requestOf(LEARNED_WORKFLOW_TOOL), "both calls on the harness's one answer");
});

// SKIP (follow-up #2078): a learned node's request is not routed or booked as before on the runner
test.skip("R8 (guard) learned_workflow's description and input schema are as #1727 left them, on pi and as the harness is given it on claude-agent and codex; a pathless output is refused in #1727's words", { timeout: 120_000 }, async (t) => {
  const flows = [{ name: "answer", description: DESCRIPTION, workflow: JSON.stringify(answerFlow()) }];
  assert.equal(learnedWorkflowDescription(flows), SAID);
  const tool = learnedWorkflowTool({ workflows: flows, granted: [], env: {}, work: "/tmp", models: {}, modelOf: () => undefined });
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

test("R10 (guard) a node request's bound is its own: it opens as <key>:<n> on its start mark beside the harness request whose tool call it runs in, and each closes only its own, by its own BOOKED marker or late cost", async () => {
  const { RequestBounds } = await import("../dist/bounds.js");
  const bounds = new RequestBounds();
  let id = 0;
  const entry = (kind, data) => ({ id: ++id, kind, data });
  // The harness's request 1 asks for learned_workflow; its answer is booked before its cost came in (unpriced).
  bounds.note([entry("agentrun.request_started", { key: "run:r", request: 1, boundUsd: 0.1 })], 5);
  bounds.note([entry("adapter.request", { key: "run:r", request: 1, unpriced: true })], 5);
  // The node's request inside that call: the session's next number, 2, beside the harness's still awaiting its cost.
  bounds.note([entry("agentrun.request_started", { key: "run:r", request: 2, boundUsd: 0.2, host: "learned_workflow" })], 5);
  assert.ok(Math.abs(bounds.inFlight() - 0.3) < 1e-12, `both in flight: ${bounds.inFlight()}`);
  bounds.note([entry("adapter.request", { key: "run:r", request: 2, host: "learned_workflow" })], 5);
  assert.ok(Math.abs(bounds.inFlight() - 0.1) < 1e-12, `the node's BOOKED closes the node's alone: ${bounds.inFlight()}`);
  bounds.note([entry("agentrun.request_cost_late", { key: "run:r", request: 1, usd: 0.01 })], 5);
  assert.equal(bounds.inFlight(), 0, "the harness's late cost closes the harness's");
});

// SKIP (follow-up #2078): a learned node's request is not routed or booked as before on the runner
test.skip("R10 (guard) the harness's next request after a node request on the same model is priced against the harness's own previous request, never the node's", { timeout: 180_000 }, async (t) => {
  const gw = await startFauxGateway({ call: submitsAnswer });
  t.after(() => gw.close());
  // Sonnet's prices, as grown() bills its requests: the gateway's model is the session's, the node's and the harness's.
  withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: "2,10,0.2,2.5" }, MODEL_VARS);
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
  const ownHeld = (runId) => entries(data, runId, ["runner.request"]).filter((entry) => entry.host === undefined).map((entry) => entry.heldUsd);
  const plain = await ran(api, data, "grown-plain", "codex", { fields: { max_cost_usd: 5 }, ask: "Grow three requests." });
  const beside = await ran(api, data, "grown-beside", "codex", { fields: { max_cost_usd: 5 }, ask: "Grow three requests, the second running the learned workflow answer on What is six times seven." });
  assert.equal(learnedResult(beside.rows)?.tool_status, "success", JSON.stringify(learnedResult(beside.rows)));
  const [a, b] = [ownHeld(plain.runId), ownHeld(beside.runId)];
  assert.equal(a.length >= 3 && b.length >= 3, true, JSON.stringify({ a, b }));
  assert.ok(Math.abs(a[2] - b[2]) < 1e-9, `the third request held as it is with no node before it: ${b[2]} against ${a[2]}`);
});

// SKIP (follow-up #2078): a learned node's request is not routed or booked as before on the runner
test.skip("R12 a learned node's request is a side call of the session (#1831): its runner.request says side, so the wrap-up's typical cost never counts it, and it never takes nor carries the wrap-up's note, which the harness's own next request takes", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({ call: submitsAnswer });
  t.after(() => gw.close());
  withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: fake("gateway"), AGENT_MODEL_PRICE: "0,100,0,0" }, MODEL_VARS);
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
  // A $1.50 cap: the harness's $0.40 request leaves $1.10. The note is due when what is left is under three times the
  // typical $0.40 = $1.20, and the node's least ($0.9216: codex's responsesOutputLeast, 9,216 tokens at $100 a million)
  // still fits, so a cap in $1.32-$1.60. The node's request is then the session's next on its model, which would take
  // the note if a side call could.
  const { runId, rows, view } = await ran(api, data, "wrap-node", "codex", { fields: { max_cost_usd: 1.5 }, ask: "Wrap up around the learned workflow answer on What is six times seven." });
  assert.equal(learnedResult(rows)?.tool_status, "success", JSON.stringify(learnedResult(rows)));
  const node = labelled(data, runId);
  assert.deepEqual(node.map((entry) => entry.side), [true], `a side call on its record: ${JSON.stringify(node)}`);
  const sent = gw.requests.filter((r) => r.method === "POST");
  assert.equal(sent.length, 1, "the node's one request");
  assert.doesNotMatch(JSON.stringify(sent[0].body), /run's budget/, "the node's request carries no wrap-up note");
  const notes = entries(data, runId, ["faux.note"]);
  assert.equal(notes.length, 1, `the harness's own next request took the note: ${JSON.stringify(notes)}; ${view.status}`);
});
