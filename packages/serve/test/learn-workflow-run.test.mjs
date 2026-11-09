// A learned workflow runs as one tool, learned_workflow, on pi, claude-agent and codex: the run's pin names the
// workflows the agent learned whose README sets no status (or `active`), never a pending or retired one; the tool's
// description names each; a call checks the workflow again against the agent's own tools, runs it with the workflow DSL
// on this server's models, and its model requests are the run's, as side requests labelled learned_workflow.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { agentFolderOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import * as learning from "../dist/learning.js";
import { LEARNED_WORKFLOW_TOOL, learnedWorkflowDescription } from "../dist/learned-workflow.js";
import { REPLAY } from "../dist/host-tools.js";
import { localWorkspace } from "../dist/workspace/index.js";
import { entriesOf, git, resnap, WORKFLOWS_TODO } from "./learn-support.mjs";
import { agent, answerFlow, call, cookieOf, follow, runDir, scratch, serve, withEnv } from "./support.mjs";
import { fauxTable } from "./fixtures/faux-table.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
const GUARD = new URL("./fixtures/net-guard.mjs", import.meta.url).pathname;
/** The owner's sign-in phrase on a test server with accounts (no real secret). */
const SIGN_IN_PHRASE = "the owner signs in with this phrase";
const ASK = "Use the learned workflow answer on What is six times seven.";
const DESCRIPTION = "Answers a question as a number; use when the person asks for the answer";
/** A learned workflow's two files, as the merge keeps them: its workflow.json and its README.md (`extra` front matter). */
const flowFiles = (name, workflow, extra = "") => ({
  [`workflows/${name}/workflow.json`]: JSON.stringify(workflow),
  [`workflows/${name}/README.md`]: `---\nname: ${name}\ndescription: ${DESCRIPTION}\n${extra}---\n`,
});
/** A one-node workflow whose node names `tools`. */
const withTools = (tools) => {
  const flow = answerFlow();
  flow.root.steps[0].tools = tools;
  return flow;
};

/** Agent `id`'s learning folder made as a first run makes it, then `files` committed on main. */
async function folderWith(data, id, files) {
  await seedOf(data, id);
  const repo = join(agentFolderOf(data, id), "learning");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
  await resnap(data, id);
}


/** Agent `id` on `harness`, learning, with `files` learned (`extra`: more of its definition); one run of ASK (`fields`:
 *  more of its start, a cap), ended: its id, rows and view. */
async function ran(api, data, id, harness, files, tools = [], { extra = {}, fields = {}, deadlineMs = 60_000, ask = ASK, ends = ["completed", "failed"] } = {}) {
  assert.equal((await api("POST", "/agents", agent(id, { learning: true, harness, instructions: ask, tools, ...extra }))).status, 201);
  await folderWith(data, id, files);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: ask }, ...fields });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { rows } = await follow(api, runId, ends, { deadlineMs });
  return { runId, rows, view: (await api("GET", `/runs/${runId}`)).body };
}
/** The learned_workflow call's result row in `rows`. */
const learnedResult = (rows) => rows.find((row) => row.kind === "tool_result" && row.tool_name === LEARNED_WORKFLOW_TOOL);

/** The node's submit, when a request offers the node's submit tool and carries no tool result yet. */
const submitsAnswer = ({ body }) => {
  const offers = (body?.tools ?? []).some((tool) => tool?.name === "submit");
  const answered = (body?.messages ?? []).some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "tool_result")) || (body?.input ?? []).some((item) => item?.type === "function_call_output");
  return offers && !answered ? { name: "submit", input: { value: { answer: 42 } } } : undefined;
};
/** A CLI harness run's model route for `t`, a faux gateway on loopback: claude-agent behind ANTHROPIC_BASE_URL, codex
 *  and opencode behind AGENT_MODEL_BASE_URL. Its learned nodes go there through the session's proxy, as the harness's own
 *  requests would; the serve options that leave pi's faux model off. */
async function routed(t, harness) {
  const gw = await startFauxGateway({ call: submitsAnswer });
  t.after(() => gw.close());
  const key = ["not-a-secret", "gateway"].join("-");
  if (harness === "claude-agent") withEnv(t, { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: gw.url, AGENT_MODEL: "anthropic/claude-sonnet-4-5" }, ["AGENT_MODEL_BASE_URL", "OPENROUTER_API_KEY", "AGENT_MODEL_PRICE"]);
  else withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: key, AGENT_MODEL_PRICE: "1,2,0.5" }, ["ANTHROPIC_BASE_URL", "OPENROUTER_API_KEY"]);
  return { faux: undefined };
}
/** faux-upstream.mjs (the provider's hosted search, as each provider streams it) served on loopback, as an operator's
 *  gateway: its origin. */
async function upstreamAt(t) {
  const send = (await import("./fixtures/faux-upstream.mjs")).default;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const answer = await send(`http://upstream.invalid${req.url}`, { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("learned_workflow is never run again after a crash, on any harness, and says each workflow and what it does", () => {
  assert.equal(LEARNED_WORKFLOW_TOOL, "learned_workflow");
  assert.equal(REPLAY[LEARNED_WORKFLOW_TOOL], "never");
  const said = learnedWorkflowDescription([{ name: "answer", description: DESCRIPTION, workflow: "{}" }]);
  assert.match(said, /^- answer: Answers a question as a number/m);
});

test("learned_workflow's description shows each workflow's input as its schema says it, compact: its fields, their types, which are required and a short description", () => {
  const flow = answerFlow();
  flow.schemas.In = { type: "object", required: ["question"], properties: { question: { type: "string", description: "The question to answer, in the person's words" }, tickets: { type: "array", items: { type: "string" } } } };
  const said = learnedWorkflowDescription([{ name: "answer", description: DESCRIPTION, workflow: JSON.stringify(flow) }]);
  assert.match(said, /^- answer: Answers a question as a number.*\n  input: \{question\* string "The question to answer, in the person's words", tickets array of string\} \(\* required\)$/m, said);
  assert.ok(learning.workflowLine({ name: "answer", description: DESCRIPTION, workflow: JSON.stringify(flow) }).includes("question* string"), "the pin's budget counts the same line");
});

test("a learned workflow whose output names no path is refused before any node runs: its output is the value at output.path", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const flow = answerFlow();
  delete flow.output.path;
  const { runId, rows } = await ran(api, data, "pathless", "pi", flowFiles("answer", flow));
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "failed", JSON.stringify(result));
  assert.match(JSON.stringify(result), /The learned workflow answer was not run: its output names no path: a learned workflow's output is the value at output\.path/, JSON.stringify(result));
  assert.deepEqual((await entriesOf({ data }, runId, ["agentrun.request_started"])).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL), [], "no node ran");
});

for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`a ${harness} run calls the workflow its agent learned as learned_workflow and gets its output, with no edit of its definition; its model requests are the run's, as side requests`, { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
    const opened = join(await scratch(t), "opened.jsonl");
    withEnv(t, { AGENTRUN_TEST_FAUX_HARNESS_OPENED: opened });
    const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), ...(harness === "pi" ? {} : await routed(t, harness)) });
    const { runId, rows, view } = await ran(api, data, `flow-${harness}`, harness, flowFiles("answer", answerFlow()));
    assert.equal(view.status, "completed", JSON.stringify(view));
    const use = rows.find((row) => row.kind === "tool_use" && row.tool_name === LEARNED_WORKFLOW_TOOL);
    assert.ok(use, JSON.stringify(rows.map((row) => [row.kind, row.tool_name, row.summary])));
    const result = rows.find((row) => row.kind === "tool_result" && row.tool_use_id === use.tool_use_id);
    assert.equal(result?.tool_status, "success", JSON.stringify(result));
    assert.match(JSON.stringify(result), /\{\\?"answer\\?":42\}/, "the workflow's output");
    if (harness === "pi") assert.match(view.result.final_answer, /\{"answer":42\}/);
    else assert.ok(readFileSync(opened, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).some((entry) => entry.tools?.includes(LEARNED_WORKFLOW_TOOL)), "the harness was given the tool");
    // Its node's request is the run's: on the runner, on every harness, a request of the run's one booking labelled
    // learned_workflow (the session's proxy, the run's ledger), never a side request of its own.
    const side = (await entriesOf({ data }, runId, ["agentrun.request_started", "agentrun.request_cost"])).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL);
    const booked = await entriesOf({ data }, runId, ["runner.request"]);
    assert.deepEqual([side, booked.filter((entry) => entry.host === LEARNED_WORKFLOW_TOOL).length], [[], 1], JSON.stringify(booked));
  });
}

test("a learned workflow whose node names a tool the agent was not granted is refused at the call, never run", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const { runId, rows } = await ran(api, data, "offlist", "pi", flowFiles("answer", withTools(["web_fetch"])));
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_name === LEARNED_WORKFLOW_TOOL);
  assert.equal(result?.tool_status, "failed", JSON.stringify(result));
  assert.match(JSON.stringify(result), /The learned workflow answer was not run: the workflow DSL refuses it/, JSON.stringify(result));
  assert.deepEqual((await entriesOf({ data }, runId, ["agentrun.request_started"])).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL), [], "no model request was sent for it");
});

for (const [why, extra] of [["waits for its owner's OK", "status: pending\n"], ["was retired", "status: retired\n"]]) {
  test(`a learned workflow that ${why} is not the run's: no harness is given learned_workflow`, { timeout: 120_000 }, async (t) => {
    const opened = join(await scratch(t), "opened.jsonl");
    withEnv(t, { AGENTRUN_TEST_FAUX_HARNESS_OPENED: opened });
    const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS) });
    const { runId, rows } = await ran(api, data, `held-${extra.includes("pending") ? "p" : "r"}`, "claude-agent", flowFiles("answer", answerFlow(), extra));
    const given = readFileSync(opened, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.tools);
    assert.ok(given.length && given.every((entry) => !entry.tools.includes(LEARNED_WORKFLOW_TOOL)), JSON.stringify(given));
    assert.ok(!rows.some((row) => row.kind === "tool_result" && row.tool_status === "success" && row.tool_name === LEARNED_WORKFLOW_TOOL));
  });
}

// Review fixes (#1616): each red first against the head before them.

/** A one-node workflow whose call node searches the web for the input's question. */
const searchFlow = () => ({
  v: 2, name: "answer",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    Search: { type: "object", required: ["query", "results"], properties: { query: { type: "string" }, results: { type: "array", minItems: 1 } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Search", path: "found" },
  root: { node: "chain", steps: [{ node: "call", label: "Search", via: "tool", tool: "web_search", args: { query: "{question}", n: 2 }, out: "Search", as: "found", deadline_s: 60 }] },
});

test("the tool's description gives its workflows a budget: by name, each whose line fits what is left of it; the ones left out are named", { timeout: 120_000 }, async (t) => {
  const long = "Answers a question as a number. ".repeat(100);
  const files = {};
  for (const name of ["a-flow", "b-flow", "c-flow", "d-flow"]) {
    files[`workflows/${name}/workflow.json`] = JSON.stringify(answerFlow());
    files[`workflows/${name}/README.md`] = `---\nname: ${name}\ndescription: ${long}\n---\n`;
  }
  // The pick a run's seed gets (learning.ts pinSeed, which the runner's seed lay makes the same pick with).
  const { pin, runDir: dir } = await pinned(t, "budgeted", files);
  // Each line is 3,209 bytes: two fit the 8 KiB, and the next two are left out.
  assert.equal(learning.LEARNED_WORKFLOWS_BUDGET, 8 * 1024);
  assert.deepEqual([pin.workflows, pin.workflows_left_out], [["a-flow", "b-flow"], ["c-flow", "d-flow"]], JSON.stringify(pin));
  const kept = JSON.parse(readFileSync(join(dir, "learned-workflows.json"), "utf8"));
  assert.ok(Buffer.byteLength(learnedWorkflowDescription(kept)) < learning.LEARNED_WORKFLOWS_BUDGET + 512, "the description stays within its budget and its two lines of what the tool does");
});

test("a learned workflow's model node runs with its own signal: a sibling branch that fails stops it at once, never after its own answer", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const flow = answerFlow();
  // The sibling's call fails at once: the guarded fetch never reaches a loopback address, and its answer is no Answer.
  flow.root.steps = [{ node: "parallel", label: "both", branches: [
    { node: "extract", label: "slow", instructions: "Answer the question.", out: "Answer", as: "answer" },
    { node: "call", label: "failing", via: "tool", tool: "web_fetch", args: { url: "http://127.0.0.1:9/" }, out: "Answer", as: "other", deadline_s: 30 },
  ] }];
  const began = Date.now();
  // The question is the node's prompt (its state): "Take your time" holds the faux model's answer 60 s, until it is stopped.
  const { rows } = await ran(api, data, "siblings", "pi", flowFiles("answer", flow), ["web_fetch"], { deadlineMs: 45_000, ask: "Use the learned workflow answer on Take your time." });
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "failed", JSON.stringify(result));
  assert.match(JSON.stringify(result), /The learned workflow answer failed/, JSON.stringify(result));
  assert.ok(Date.now() - began < 40_000, `the slow node (60 s) was stopped with its sibling: ${Date.now() - began} ms`);
});

test("a learned workflow whose later model node names a tool, though the agent was granted it, is refused before any node runs: no model request is sent", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const flow = answerFlow();
  flow.root.steps = [
    { node: "extract", label: "first", instructions: "Answer the question.", out: "Answer", as: "first" },
    { node: "extract", label: "second", instructions: "Answer the question.", out: "Answer", as: "answer", tools: ["web_fetch"] },
  ];
  const { runId, rows } = await ran(api, data, "late-tools", "pi", flowFiles("answer", flow), ["web_fetch"]);
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "failed", JSON.stringify(result));
  assert.match(JSON.stringify(result), /The learned workflow answer was not run: the model node at \/root\/steps\/1 names a tool \(web_fetch\): a learned workflow's model node runs without tools/, JSON.stringify(result));
  assert.deepEqual((await entriesOf({ data }, runId, ["agentrun.request_started"])).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL), [], "its first node never ran");
});

test("a learned workflow whose later agent node asks context fork is refused before any node runs: no model request is sent", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const flow = answerFlow();
  flow.root.steps = [
    { node: "extract", label: "first", instructions: "Answer the question.", out: "Answer", as: "first" },
    { node: "agent", label: "forked", instructions: "Answer the question.", out: "Answer", as: "answer", context: "fork" },
  ];
  const { runId, rows } = await ran(api, data, "forked-flow", "pi", flowFiles("answer", flow));
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "failed", JSON.stringify(result));
  assert.match(JSON.stringify(result), /The learned workflow answer was not run: .*asks context fork/, JSON.stringify(result));
  assert.deepEqual((await entriesOf({ data }, runId, ["agentrun.request_started"])).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL), [], "its first node never ran");
});

test("a learned workflow whose later agent node asks max_turns over the learned runner's cap is refused before any node runs: no model request is sent", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const flow = answerFlow();
  flow.root.steps = [
    { node: "extract", label: "first", instructions: "Answer the question.", out: "Answer", as: "first" },
    { node: "agent", label: "long", instructions: "Answer the question.", out: "Answer", as: "answer", max_turns: 10 },
  ];
  const { runId, rows } = await ran(api, data, "long-turns", "pi", flowFiles("answer", flow));
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "failed", JSON.stringify(result));
  assert.match(JSON.stringify(result), /The learned workflow answer was not run: .*asks max_turns 10/, JSON.stringify(result));
  assert.deepEqual((await entriesOf({ data }, runId, ["agentrun.request_started"])).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL), [], "its first node never ran");
});

test("a learned workflow whose later node is a judge is refused before any node runs: no model request is sent", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const flow = answerFlow();
  flow.schemas.Check = { type: "object", properties: { right: { type: "boolean", description: "Is the answer right?" } }, required: ["right"] };
  flow.root.steps = [
    { node: "extract", label: "first", instructions: "Answer the question.", out: "Answer", as: "answer" },
    { node: "judge", label: "check", state: { answer: "{answer}" }, out: "Check", as: "check" },
  ];
  const { runId, rows } = await ran(api, data, "late-judge", "pi", flowFiles("answer", flow));
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "failed", JSON.stringify(result));
  assert.match(JSON.stringify(result), /The learned workflow answer was not run: .*judge node \\?"check\\?" requires runJudge/, JSON.stringify(result));
  assert.deepEqual((await entriesOf({ data }, runId, ["agentrun.request_started"])).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL), [], "its first node never ran");
});

/** Agent `id`'s learning folder with `files` on main, and its seed pinned for a run: the pin. */
async function pinned(t, id, files, secrets = [], extra = {}) {
  const data = join(await scratch(t), "agents");
  mkdirSync(data, { recursive: true });
  await folderWith(data, id, files);
  const runDir = join(await scratch(t), "run");
  mkdirSync(join(runDir, "work"), { recursive: true });
  const seed = await seedOf(data, id);
  return { seed, runDir, pin: await learning.pinSeed(runDir, localWorkspace(join(runDir, "work")), seed, { budget: 8000, read: false, shown: learning.secretsShown(secrets), ...extra }) };
}

test("a learned workflow whose README's front matter does not read one way (not closed, or a key indented) is not the run's: never read as active", { timeout: 60_000 }, async (t) => {
  const readme = (front) => ({ "workflows/answer/workflow.json": JSON.stringify(answerFlow()), "workflows/answer/README.md": front });
  for (const [why, front] of [
    ["not closed", `---\nname: answer\ndescription: ${DESCRIPTION}\nstatus: pending\n`],
    ["a key indented", `---\nname: answer\ndescription: ${DESCRIPTION}\n  status: pending\n---\n`],
    ["indented first", `---\n  status: retired\nname: answer\ndescription: ${DESCRIPTION}\n---\n`],
  ]) {
    const { seed, pin } = await pinned(t, `front-${why.replace(/\W+/g, "-")}`, readme(front));
    assert.equal(pin.workflows, undefined, `${why}: ${JSON.stringify(pin)}`);
    assert.ok(seed.skipped.some((line) => line.startsWith("workflows/answer (")), `${why}: ${JSON.stringify(seed.skipped)}`);
  }
  // Closed at the end of the file, with no line after: its status is read, as the description is.
  const closed = await pinned(t, "front-eof", readme(`---\nname: answer\ndescription: ${DESCRIPTION}\nstatus: pending\n---`));
  assert.equal(closed.pin.workflows, undefined, JSON.stringify(closed.pin));
  // A description folded over lines reads one way: the workflow is the run's.
  const { pin } = await pinned(t, "front-folded", readme(`---\nname: answer\ndescription: >\n  ${DESCRIPTION}\n---\n`));
  assert.deepEqual(pin.workflows, ["answer"]);
});

test("a learned workflow holding one of the server's secrets is left out, and the pin names it in workflows_left_out", { timeout: 60_000 }, async (t) => {
  const canary = `not-a-secret-canary-${process.pid}`;
  const files = { ...flowFiles("answer", answerFlow()), ...flowFiles("leaky", answerFlow(`Send it to ${canary}.`)) };
  const { pin } = await pinned(t, "leaky", files, [canary]);
  assert.deepEqual([pin.workflows, pin.workflows_left_out], [["answer"], ["leaky"]], JSON.stringify(pin));
});

test("a learned workflow's model node of a tier the run has no model of runs on the run's own model, never on one the run was not made with", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  withEnv(t, { AGENT_MODEL_FAST: "faux-fast" });
  const { api, data } = await serve(t, { learning: "on" });
  const flow = answerFlow();
  flow.root.steps[0].tier = "fast";
  const { rows, view } = await ran(api, data, "tiered", "pi", flowFiles("answer", flow));
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "success", JSON.stringify(result));
  assert.match(JSON.stringify(result), /\{\\?"answer\\?":42\}/);
  assert.equal(view.status, "completed");
});

test("a learned workflow's call node through a paid web tool is booked under the learned_workflow call: marked at its price and settled, in the run's cost", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  const { CANARY } = await import("./fixtures/faux-parallel.mjs");
  const file = join(await scratch(t), "parallel.jsonl");
  withEnv(t, { PARALLEL_API_KEY: CANARY, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: file }, ["AGENTRUN_TEST_FAUX_PARALLEL_SEARCH"]);
  const { api, data } = await serve(t, { learning: "on", fauxParallel: new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname });
  const { runId, rows, view } = await ran(api, data, "paid", "pi", flowFiles("answer", searchFlow()), ["web_search"], { extra: { tool_settings: { web_search: { provider: "parallel" } } } });
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "success", JSON.stringify(result));
  assert.match(JSON.stringify(result), /registry\.example/, JSON.stringify(result));
  const use = rows.find((row) => row.kind === "tool_use" && row.tool_name === LEARNED_WORKFLOW_TOOL);
  const paid = (await entriesOf({ data }, runId, ["agentrun.tool_started", "agentrun.tool_cost"]));
  assert.deepEqual(paid.map((entry) => [entry.kind, entry.tool, entry.charged_by, entry.heldUsd ?? entry.usd]), [["agentrun.tool_started", "web_search", "parallel", 0.001], ["agentrun.tool_cost", "web_search", "parallel", 0.001]]);
  assert.ok(paid.every((entry) => entry.call === `${use.tool_use_id}/Search@${paid[0].call.split("@")[1]}`), `booked under the tool's call, as its node's own: ${paid.map((entry) => entry.call)}`);
  assert.equal(view.cost.usd, 0.001, "the faux model is $0: the run's cost is Parallel's fee");
});

test("a claude-agent run's learned workflow searches natively through the session's proxy: its call node's web_search on the provider's hosted search, at the operator's gateway", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  const dir = await scratch(t);
  const upstream = join(dir, "upstream.jsonl");
  withEnv(t, { ANTHROPIC_API_KEY: "not-a-secret", ANTHROPIC_BASE_URL: await upstreamAt(t), AGENT_MODEL: "anthropic/claude-sonnet-4-5", AGENTRUN_TEST_FAUX_UPSTREAM_CALLS: upstream }, ["PARALLEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENTRUN_TEST_FAUX_UPSTREAM"]);
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
  assert.equal((await api("PUT", "/settings/tools", { web_search: { provider: "native" } })).status, 200);
  const { rows } = await ran(api, data, "native-flow", "claude-agent", flowFiles("answer", searchFlow()), ["web_search"]);
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "success", JSON.stringify(result));
  assert.match(JSON.stringify(result), /public\.example/, JSON.stringify(result));
  const sent = readFileSync(upstream, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(sent.map((call) => call.path), ["/v1/messages"], "one request to the provider's hosted search");
});

test("a claude-agent run on Claude's dotted name (anthropic/claude-sonnet-4.5) with a direct key searches natively on the model its run prepared: the dashed one its models hold", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  const dir = await scratch(t);
  const upstream = join(dir, "upstream.jsonl");
  // The session's proxy forwards to claude-agent's own provider: ANTHROPIC_BASE_URL, set here for the server, at the
  // served faux upstream on loopback, checked before the run; the net guard in the run's process refuses anything else.
  const base = await upstreamAt(t);
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/, "the provider is the loopback faux upstream");
  const guardLog = join(dir, "guard.jsonl");
  withEnv(t, { ANTHROPIC_API_KEY: "not-a-secret", ANTHROPIC_BASE_URL: base, AGENT_MODEL: "anthropic/claude-sonnet-4.5", AGENTRUN_TEST_FAUX_UPSTREAM_CALLS: upstream, NET_GUARD_LOG: guardLog, NODE_OPTIONS: `--import=${pathToFileURL(GUARD).href}` }, ["PARALLEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENTRUN_TEST_FAUX_UPSTREAM", "OPENROUTER_API_KEY", "NODE_OPTIONS", "NET_GUARD_LOG"]);
  assert.equal(process.env.ANTHROPIC_BASE_URL, base, "the server's env names it");
  const { api, data } = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), faux: undefined });
  assert.equal((await api("PUT", "/settings/tools", { web_search: { provider: "native" } })).status, 200);
  const { rows } = await ran(api, data, "dotted-flow", "claude-agent", flowFiles("answer", searchFlow()), ["web_search"]);
  const result = learnedResult(rows);
  assert.doesNotMatch(JSON.stringify(result), /no model to search on/, JSON.stringify(result));
  assert.equal(result?.tool_status, "success", JSON.stringify(result));
  const sent = readFileSync(upstream, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(sent.map((call) => call.path), ["/v1/messages"], "one request to the provider's hosted search");
  const refused = existsSync(guardLog) ? readFileSync(guardLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.kind === "refused") : [];
  assert.deepEqual(refused.map((line) => line.host), [], "nothing past loopback")
});

// The faux model priced on output alone, $100 a million tokens: a request's least (1,024 tokens) is $0.1024. The faux
// harness books each of its requests at $0.001. Under the faux harness claude-agent and codex run one path.
test("learned_workflow is a tool the gate holds like any: its settings key is learned_workflow, it defaults to allow, and an agent may set it to ask or deny", async () => {
  const { settingsKeyOf, defaultPermission } = await import("../dist/tool-gate.js");
  const { settingsIssues, SERVE_OWN_TOOLS } = await import("../dist/tool-plane.js");
  assert.ok(SERVE_OWN_TOOLS.includes(LEARNED_WORKFLOW_TOOL), "the plane's own tools name it");
  for (const harness of ["pi", "claude-agent", "codex", "opencode"]) assert.equal(settingsKeyOf(harness, LEARNED_WORKFLOW_TOOL), LEARNED_WORKFLOW_TOOL, harness);
  assert.equal(settingsKeyOf("claude-agent", `mcp__hands__${LEARNED_WORKFLOW_TOOL}`), LEARNED_WORKFLOW_TOOL, "claude-agent's host tool name");
  assert.equal(defaultPermission(LEARNED_WORKFLOW_TOOL), "allow");
  for (const permission of ["allow", "ask", "deny"]) assert.deepEqual(settingsIssues({ [LEARNED_WORKFLOW_TOOL]: { permission } }), [], permission);
});

test("on pi, learned_workflow set to deny for the agent is refused by the gate in its words: no node runs", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const { runId, rows } = await ran(api, data, "denied-flow", "pi", flowFiles("answer", answerFlow()), [], { extra: { tool_settings: { [LEARNED_WORKFLOW_TOOL]: { permission: "deny" } } } });
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "failed", JSON.stringify(result));
  assert.match(JSON.stringify(result), /Permission denied: learned_workflow is set to deny for this agent/, JSON.stringify(result));
  assert.deepEqual((await entriesOf({ data }, runId, ["agentrun.request_started"])).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL), [], "no node ran");
});

for (const harness of ["codex", "claude-agent"]) {
  test(`on ${harness}, learned_workflow set to ask parks the run; the owner's allow runs it once (its node's request goes out once the allow un-parks the run) and the run resumes with its output`, { timeout: 180_000, skip: WORKFLOWS_TODO }, async (t) => {
    const server = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), accounts: true, openSetup: true, ...(await routed(t, harness)) });
    const { api, data } = server;
    const origin = `http://127.0.0.1:${server.port}`;
    const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { "content-type": "application/json", origin }, body: { password: SIGN_IN_PHRASE } });
    assert.equal(setup.status, 201, setup.text);
    const cookie = cookieOf(setup);
    const { runId } = await ran(api, data, `asked-${harness}`, harness, flowFiles("answer", answerFlow()), [], { extra: { tool_settings: { [LEARNED_WORKFLOW_TOOL]: { permission: "ask" } } }, ends: ["input_required", "completed", "failed"] });
    const view = (await api("GET", `/runs/${runId}`)).body;
    assert.deepEqual([view.status, view.pending?.kind, view.pending?.tool], ["input_required", "approval", LEARNED_WORKFLOW_TOOL], JSON.stringify(view));
    // The parked run's process holds its store: what ran is read once it ends (one request, after the allow).
    const answered = await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${view.pending.id}`, headers: { "content-type": "application/json", cookie, origin }, body: { decision: "allow" } });
    assert.equal(answered.status, 204, answered.text);
    const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
    assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed");
    // The gate's resume is AgentRun's row (origin "server"), never the person's message, and it carries the call's result.
    const resumed = rows.find((row) => row.origin === "server" && /^AgentRun: learned_workflow /.test(row.summary ?? ""));
    assert.deepEqual([resumed?.kind, resumed?.origin], ["phase", "server"], JSON.stringify(resumed));
    assert.match(resumed.summary, /^AgentRun: learned_workflow ran once you allowed it; its result went to the agent$/, resumed.summary);
    // What a person reads: the outcome and the result, with no call id (the model's message keeps it).
    assert.match(resumed.text, /^learned_workflow ran once you allowed it\. Its result:\n\{\\?"answer\\?":42\}/, resumed.text);
    assert.ok(!resumed.text.includes(view.pending.call_id), "no call id in the row's text");
    assert.equal(rows.some((row) => row.kind === "user_message" && String(row.text).startsWith("[tool approval]")), false, "never shown as the person's message");
    assert.equal((await entriesOf({ data }, runId, ["runner.request"])).filter((entry) => entry.host === LEARNED_WORKFLOW_TOOL).length, 1, "its one node ran once, through the session's proxy");
    // No early window: from the park to the resume's message, the only request that leaves is the approved call's node; the
    // harness's own wait for the turn that message starts.
    const seq = (await entriesOf({ data }, runId, ["agentrun.tool_approval", "agentrun.request_started", "adapter.message"]));
    const parkedAt = seq.findIndex((entry) => entry.kind === "agentrun.tool_approval" && entry.phase === "requested");
    const resumedAt = seq.findIndex((entry) => entry.kind === "adapter.message" && String(entry.id).startsWith("approval-"));
    assert.ok(parkedAt >= 0 && resumedAt > parkedAt, JSON.stringify(seq.map((entry) => [entry.kind, entry.phase ?? entry.request ?? entry.id])));
    const between = seq.slice(parkedAt + 1, resumedAt).filter((entry) => entry.kind === "agentrun.request_started");
    assert.deepEqual(between.map((entry) => entry.host ?? "the harness's own"), [LEARNED_WORKFLOW_TOOL], "between the park and the resume, only the node's request");
  });
}

// The owner's allow can land while the harness is still recording the parked call's result (Claude Code writes it before
// it reads the next answer). The parked call stays the turn's to end: its result interrupts the turn, and no request of
// the harness's own leaves after the allow; the approved call's node is the one request that does.
for (const harness of ["codex", "claude-agent"]) {
  test(`on ${harness}, an allow that lands before the parked call's result is in still ends the parked turn: interrupted, with no request of the harness's own after the allow until the resume's turn`, { timeout: 180_000, skip: WORKFLOWS_TODO }, async (t) => {
    const held = join(await scratch(t), "result-held");
    const ask = `Use the learned workflow answer on What is six times seven, its result held until ${held}.`;
    const gw = await startFauxGateway({ call: submitsAnswer });
    t.after(() => gw.close());
    const key = ["not-a-secret", "gateway"].join("-");
    if (harness === "claude-agent") withEnv(t, { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: gw.url, AGENT_MODEL: "anthropic/claude-sonnet-4-5" }, ["AGENT_MODEL_BASE_URL", "OPENROUTER_API_KEY", "AGENT_MODEL_PRICE"]);
    else withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL: "gpt-test", AGENT_MODEL_API_KEY: key, AGENT_MODEL_PRICE: "1,2,0.5" }, ["ANTHROPIC_BASE_URL", "OPENROUTER_API_KEY"]);
    const server = await serve(t, { learning: "on", harnessTable: fauxTable(FAUX_HARNESS), accounts: true, openSetup: true, faux: undefined });
    const { api, data } = server;
    const origin = `http://127.0.0.1:${server.port}`;
    const setup = await call(server.port, { method: "POST", path: "/v2/setup", headers: { "content-type": "application/json", origin }, body: { password: SIGN_IN_PHRASE } });
    assert.equal(setup.status, 201, setup.text);
    const cookie = cookieOf(setup);
    const id = `held-${harness}`;
    assert.equal((await api("POST", "/agents", agent(id, { learning: true, harness, instructions: ask, tools: [], tool_settings: { [LEARNED_WORKFLOW_TOOL]: { permission: "ask" } } }))).status, 201);
    await folderWith(data, id, flowFiles("answer", answerFlow()));
    const started = await api("POST", `/agents/${id}/runs`, { input: { content: ask } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const runId = started.body.run_id;
    // The call is parked and asks the owner while its result is still held: the allow lands before it.
    // The gate names the parked call by the call, its tool and its arguments (tool-gate.ts); the run reads as working
    // while the harness is still recording the call's result, and the allow is taken as soon as the server knows the ask.
    const pendingId = `ap_${createHash("sha256").update(JSON.stringify([`run:${runId}:0`, LEARNED_WORKFLOW_TOOL, { name: "answer", input: { question: "What is six times seven" } }])).digest("hex").slice(0, 16)}`;
    let answered;
    for (const deadline = Date.now() + 60_000; (answered = await call(server.port, { method: "POST", path: `/v2/runs/${runId}/approvals/${pendingId}`, headers: { "content-type": "application/json", cookie, origin }, body: { decision: "allow" } })).status === 404; await new Promise((resolve) => setTimeout(resolve, 100))) assert.ok(Date.now() < deadline, `the call asks the owner: ${answered.text}`);
    assert.equal(answered.status, 204, answered.text);
    assert.equal((await api("GET", `/runs/${runId}`)).body.status, "working", "the allow landed while the parked turn was still recording its call's result");
    // The approved call runs (its node's request reaches the gateway), and only then does the harness tell its result.
    for (const deadline = Date.now() + 60_000; !gw.requests.some((request) => submitsAnswer(request)); await new Promise((resolve) => setTimeout(resolve, 100))) assert.ok(Date.now() < deadline, "the approved call's node is sent");
    await new Promise((resolve) => setTimeout(resolve, 500));
    writeFileSync(held, "");
    await follow(api, runId, ["completed", "failed"], { deadlineMs: 90_000 });
    assert.equal((await api("GET", `/runs/${runId}`)).body.status, "completed");
    // The parked turn: its one request (the call), then its end, interrupted on the call's result, never going on after
    // the allow; the resume's turn answers.
    const seq = (await entriesOf({ data }, runId, ["agentrun.request_started", "adapter.turn_end"]));
    const firstEnd = seq.findIndex((entry) => entry.kind === "adapter.turn_end");
    const parkedTurn = seq.slice(0, firstEnd).filter((entry) => entry.host === undefined).length;
    assert.deepEqual([parkedTurn, seq[firstEnd]?.status, seq[firstEnd]?.answer ?? null], [1, "interrupted", null], `the parked turn went on after the allow: ${JSON.stringify(seq.map((entry) => [entry.kind, entry.host ?? entry.status ?? ""]))}`);
  });
}

/** A learned workflow of one call node on `tool`, or that node inside a composed workflow node (`nested`). */
const callFlow = (tool, nested = false) => {
  const inner = { v: 2, name: "fetch-one", schemas: { In: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }, Page: { type: "object" } }, input: { schemaId: "In" }, output: { schemaId: "Page", path: "page" }, root: { node: "call", label: "fetch", via: "tool", tool, args: { url: "{url}" }, out: "Page", as: "page", deadline_s: 30 } };
  return nested ? { ...inner, output: { schemaId: "Page", path: "got" }, root: { node: "workflow", label: "sub", workflow: inner, input: { url: "{url}" }, out: "Page", as: "got" } } : inner;
};

test("a learned workflow whose call node's tool was set to deny after it was learned is refused before any node runs, in #1601's words", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const { runId, rows } = await ran(api, data, "denied-call", "pi", flowFiles("answer", callFlow("web_fetch")), ["web_fetch"], { extra: { tool_settings: { web_fetch: { permission: "deny" } } } });
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "failed", JSON.stringify(result));
  assert.match(JSON.stringify(result), /The learned workflow answer was not run: This workflow's call node calls web_fetch, which is set to deny for this agent\./, JSON.stringify(result));
  assert.deepEqual((await entriesOf({ data }, runId, ["agentrun.request_started"])).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL), [], "no node ran");
});

test("each call node of a learned workflow asks the run's gate as it runs, a composed workflow's inner call node too: a tool set to deny since the call began is refused in the gate's words, ask in the call node's, and never run", async () => {
  const { runLearned } = await import("../dist/learned-workflow.js");
  const { deniedText } = await import("../dist/tool-gate.js");
  for (const nested of [false, true]) {
    for (const [later, words] of [["deny", deniedText("web_fetch")], ["ask", "This web_fetch call needs a person's approval, which a workflow's call node cannot wait for; it was not run."]]) {
      // Allowed when the call begins (its check before any node runs), `later` from then on: as a person's change mid-run.
      let asked = 0;
      const policy = (tool) => (tool === "web_fetch" && asked++ === 0 ? "allow" : tool === "web_fetch" ? later : "allow");
      const flow = { name: "answer", description: "Fetches a page", workflow: JSON.stringify(callFlow("web_fetch", nested)) };
      const run = { workflows: [flow], granted: ["web_fetch"], env: {}, work: "/nonexistent", models: { getModel: () => undefined, getModels: () => [] }, modelOf: () => undefined, policy };
      const out = await runLearned(run, flow, { url: "http://127.0.0.1:9/" });
      assert.equal(out.isError, true, JSON.stringify(out));
      assert.ok(out.text.includes(words), `${nested ? "nested" : "flat"} ${later}: ${out.text}`);
      assert.ok(asked >= 2, `${nested ? "nested" : "flat"} ${later}: the gate was asked at the call too (${asked})`);
    }
  }
});

test("a learned workflow's input line reads a reference in the schema's own definitions first, as the DSL does, whatever a sibling schema of the same name says", () => {
  const withDefs = (sibling) => ({ name: "refs", description: DESCRIPTION, workflow: JSON.stringify({
    v: 2, name: "refs",
    schemas: { In: { type: "object", definitions: { Name: { type: "string" } }, properties: { who: { $ref: "#/definitions/Name" } }, required: ["who"] }, ...(sibling ? { Name: { type: "number" } } : {}), Out: { type: "object", properties: { a: { type: "string" } } } },
    input: { schemaId: "In" }, output: { schemaId: "Out", path: "out" },
    root: { node: "extract", label: "n", instructions: "Answer.", out: "Out", as: "out" },
  }) });
  for (const sibling of [false, true]) assert.match(learning.workflowLine(withDefs(sibling)), /input: \{who\* string\}/, `sibling ${sibling}`);
});

test("a learned workflow's call reads on the run's timeline as the workflow it ran and what it gave: 'Ran the learned workflow <name>' and its output in one line", { timeout: 120_000, skip: WORKFLOWS_TODO }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const { rows } = await ran(api, data, "labelled", "pi", flowFiles("answer", answerFlow()));
  const use = rows.find((row) => row.kind === "tool_use" && row.tool_name === LEARNED_WORKFLOW_TOOL);
  const result = learnedResult(rows);
  assert.equal(use?.summary, "Ran the learned workflow answer", JSON.stringify(use));
  assert.equal(result?.tool_status, "success", JSON.stringify(result));
  assert.equal(result?.summary, "Ran the learned workflow answer: answer 42", JSON.stringify(result));
});
