// A learned workflow runs as one tool, learned_workflow, on pi, claude-agent and codex: the run's pin names the
// workflows the agent learned whose README sets no status (or `active`), never a pending or retired one; the tool's
// description names each; a call checks the workflow again against the agent's own tools, runs it with the workflow DSL
// on this server's models, and its model requests are the run's, as side requests labelled learned_workflow.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { homeOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import * as learning from "../dist/learning.js";
import { LEARNED_WORKFLOW_TOOL, learnedWorkflowDescription } from "../dist/learned-workflow.js";
import { REPLAY } from "../dist/host-tools.js";
import { git } from "./learn-support.mjs";
import { agent, answerFlow, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_HARNESS = new URL("./fixtures/faux-harness.mjs", import.meta.url).pathname;
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
  const repo = join(homeOf(data, id), "learning");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ["add", "--", ...Object.keys(files)]);
  git(repo, ["commit", "-q", "-m", "learned"]);
}

const pinOf = (data, runId) => JSON.parse(readFileSync(join(data, "runs", runId, "learning.json"), "utf8"));
/** The run's root entries of `kinds`, from its store. */
function entries(data, runId, kinds) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
  try {
    return db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((entry) => kinds.includes(entry.kind)).map((entry) => ({ kind: entry.kind, ...entry.data }));
  } finally {
    db.close();
  }
}

/** Agent `id` on `harness`, learning, with `files` learned (`extra`: more of its definition); one run of ASK (`fields`:
 *  more of its start, a cap), ended: its id, rows and view. */
async function ran(api, data, id, harness, files, tools = [], { extra = {}, fields = {}, deadlineMs = 60_000, ask = ASK } = {}) {
  assert.equal((await api("POST", "/agents", agent(id, { learning: true, harness, instructions: ask, tools, ...extra }))).status, 201);
  await folderWith(data, id, files);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: ask }, ...fields });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs });
  return { runId, rows, view: (await api("GET", `/runs/${runId}`)).body };
}
/** The learned_workflow call's result row in `rows`. */
const learnedResult = (rows) => rows.find((row) => row.kind === "tool_result" && row.tool_name === LEARNED_WORKFLOW_TOOL);

test("learned_workflow is never run again after a crash, on any harness, and says each workflow and what it does", () => {
  assert.equal(LEARNED_WORKFLOW_TOOL, "learned_workflow");
  assert.equal(REPLAY[LEARNED_WORKFLOW_TOOL], "never");
  const said = learnedWorkflowDescription([{ name: "answer", description: DESCRIPTION, workflow: "{}" }]);
  assert.match(said, /^- answer: Answers a question as a number/m);
});

for (const harness of ["pi", "claude-agent", "codex"]) {
  test(`a ${harness} run calls the workflow its agent learned as learned_workflow and gets its output, with no edit of its definition; its model requests are the run's, as side requests`, { timeout: 120_000 }, async (t) => {
    const opened = join(await scratch(t), "opened.jsonl");
    withEnv(t, { AGENTRUN_TEST_FAUX_HARNESS_OPENED: opened });
    const { api, data } = await serve(t, { learning: "on", fauxHarness: FAUX_HARNESS });
    const { runId, rows, view } = await ran(api, data, `flow-${harness}`, harness, flowFiles("answer", answerFlow()));
    assert.equal(view.status, "completed", JSON.stringify(view));
    assert.deepEqual(pinOf(data, runId).workflows, ["answer"], "the pin names the learned workflow");
    const use = rows.find((row) => row.kind === "tool_use" && row.tool_name === LEARNED_WORKFLOW_TOOL);
    assert.ok(use, JSON.stringify(rows.map((row) => [row.kind, row.tool_name, row.summary])));
    const result = rows.find((row) => row.kind === "tool_result" && row.tool_use_id === use.tool_use_id);
    assert.equal(result?.tool_status, "success", JSON.stringify(result));
    assert.match(JSON.stringify(result), /\{\\?"answer\\?":42\}/, "the workflow's output");
    if (harness === "pi") assert.match(view.result.final_answer, /\{"answer":42\}/);
    else assert.ok(readFileSync(opened, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).some((entry) => entry.tools?.includes(LEARNED_WORKFLOW_TOOL)), "the harness was given the tool");
    // Its node's request went through the run's models: marked and costed as a side request of its own.
    const side = entries(data, runId, ["agentrun.request_started", "agentrun.request_cost"]).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL);
    assert.deepEqual(side.map((entry) => entry.kind), ["agentrun.request_started", "agentrun.request_cost"], JSON.stringify(side));
  });
}

test("a learned workflow whose node names a tool the agent was not granted is refused at the call, never run", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const { runId, rows } = await ran(api, data, "offlist", "pi", flowFiles("answer", withTools(["web_fetch"])));
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_name === LEARNED_WORKFLOW_TOOL);
  assert.equal(result?.tool_status, "failed", JSON.stringify(result));
  assert.match(JSON.stringify(result), /The learned workflow answer was not run: the workflow DSL refuses it/, JSON.stringify(result));
  assert.deepEqual(entries(data, runId, ["agentrun.request_started"]).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL), [], "no model request was sent for it");
});

for (const [why, extra] of [["waits for its owner's OK", "status: pending\n"], ["was retired", "status: retired\n"]]) {
  test(`a learned workflow that ${why} is not the run's: its pin names none, and no harness is given learned_workflow`, { timeout: 120_000 }, async (t) => {
    const opened = join(await scratch(t), "opened.jsonl");
    withEnv(t, { AGENTRUN_TEST_FAUX_HARNESS_OPENED: opened });
    const { api, data } = await serve(t, { learning: "on", fauxHarness: FAUX_HARNESS });
    const { runId, rows } = await ran(api, data, `held-${extra.includes("pending") ? "p" : "r"}`, "claude-agent", flowFiles("answer", answerFlow(), extra));
    assert.equal(pinOf(data, runId).workflows, undefined, JSON.stringify(pinOf(data, runId)));
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

test("the tool's description gives its workflows a budget: by name, each whose line fits what is left of it; the pin names the ones left out", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on" });
  const long = "Answers a question as a number. ".repeat(100);
  const files = {};
  for (const name of ["a-flow", "b-flow", "c-flow", "d-flow"]) {
    files[`workflows/${name}/workflow.json`] = JSON.stringify(answerFlow());
    files[`workflows/${name}/README.md`] = `---\nname: ${name}\ndescription: ${long}\n---\n`;
  }
  const { runId } = await ran(api, data, "budgeted", "pi", files);
  const pin = pinOf(data, runId);
  // Each line is 3,209 bytes: two fit the 8 KiB, and the next two are left out.
  assert.equal(learning.LEARNED_WORKFLOWS_BUDGET, 8 * 1024);
  assert.deepEqual([pin.workflows, pin.workflows_left_out], [["a-flow", "b-flow"], ["c-flow", "d-flow"]], JSON.stringify(pin));
  const kept = JSON.parse(readFileSync(join(data, "runs", runId, "learned-workflows.json"), "utf8"));
  assert.ok(Buffer.byteLength(learnedWorkflowDescription(kept)) < learning.LEARNED_WORKFLOWS_BUDGET + 512, "the description stays within its budget and its two lines of what the tool does");
});

test("a learned workflow's model node runs with its own signal: a sibling branch that fails stops it at once, never after its own answer", { timeout: 120_000 }, async (t) => {
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

test("a learned workflow whose later model node names a tool, though the agent was granted it, is refused before any node runs: no model request is sent", { timeout: 120_000 }, async (t) => {
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
  assert.deepEqual(entries(data, runId, ["agentrun.request_started"]).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL), [], "its first node never ran");
});

/** Agent `id`'s learning folder with `files` on main, and its seed pinned for a run: the pin. */
async function pinned(t, id, files, secrets = [], extra = {}) {
  const data = join(await scratch(t), "agents");
  mkdirSync(data, { recursive: true });
  await folderWith(data, id, files);
  const runDir = join(await scratch(t), "run");
  mkdirSync(join(runDir, "work"), { recursive: true });
  const seed = await seedOf(data, id);
  return { seed, pin: await learning.pinSeed(runDir, join(runDir, "work"), seed, { budget: 8000, read: false, shown: learning.secretsShown(secrets), ...extra }) };
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

test("a learned workflow's model node of a tier the run has no model of runs on the run's own model, never on one the run was not made with", { timeout: 120_000 }, async (t) => {
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

test("a learned workflow's call node through a paid web tool is booked under the learned_workflow call: marked at its price and settled, in the run's cost", { timeout: 120_000 }, async (t) => {
  const { CANARY } = await import("./fixtures/faux-parallel.mjs");
  const file = join(await scratch(t), "parallel.jsonl");
  withEnv(t, { PARALLEL_API_KEY: CANARY, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: file }, ["AGENTRUN_TEST_FAUX_PARALLEL_SEARCH"]);
  const { api, data } = await serve(t, { learning: "on", fauxParallel: new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname });
  const { runId, rows, view } = await ran(api, data, "paid", "pi", flowFiles("answer", searchFlow()), ["web_search"], { extra: { tool_settings: { web_search: { provider: "parallel" } } } });
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "success", JSON.stringify(result));
  assert.match(JSON.stringify(result), /registry\.example/, JSON.stringify(result));
  const use = rows.find((row) => row.kind === "tool_use" && row.tool_name === LEARNED_WORKFLOW_TOOL);
  const paid = entries(data, runId, ["agentrun.tool_started", "agentrun.tool_cost"]);
  assert.deepEqual(paid.map((entry) => [entry.kind, entry.tool, entry.charged_by, entry.heldUsd ?? entry.usd]), [["agentrun.tool_started", "web_search", "parallel", 0.001], ["agentrun.tool_cost", "web_search", "parallel", 0.001]]);
  assert.ok(paid.every((entry) => entry.call === `${use.tool_use_id}/Search@${paid[0].call.split("@")[1]}`), `booked under the tool's call, as its node's own: ${paid.map((entry) => entry.call)}`);
  assert.equal(view.cost.usd, 0.001, "the faux model is $0: the run's cost is Parallel's fee");
});

test("a claude-agent run's learned workflow searches natively through the run's models: its call node's web_search on the provider's hosted search", { timeout: 120_000 }, async (t) => {
  const dir = await scratch(t);
  const upstream = join(dir, "upstream.jsonl");
  withEnv(t, { ANTHROPIC_API_KEY: "not-a-secret", AGENT_MODEL: "anthropic/claude-sonnet-4-5", AGENTRUN_TEST_FAUX_UPSTREAM_CALLS: upstream }, ["PARALLEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENTRUN_TEST_FAUX_UPSTREAM"]);
  const { api, data } = await serve(t, { learning: "on", fauxHarness: FAUX_HARNESS, fauxUpstream: new URL("./fixtures/faux-upstream.mjs", import.meta.url).pathname });
  assert.equal((await api("PUT", "/settings/tools", { web_search: { provider: "native" } })).status, 200);
  const { rows } = await ran(api, data, "native-flow", "claude-agent", flowFiles("answer", searchFlow()), ["web_search"]);
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "success", JSON.stringify(result));
  assert.match(JSON.stringify(result), /public\.example/, JSON.stringify(result));
  const sent = readFileSync(upstream, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(sent.map((call) => call.path), ["/v1/messages"], "one request to the provider's hosted search");
});

const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;
/** The run's harness requests' records, from its store: each with the worst case its cap held it at. */
function harnessRequests(data, runId) {
  const db = new DatabaseSync(join(data, "runs", runId, "store", "run.sqlite"), { readOnly: true, timeout: 2_000 });
  try {
    return db.prepare("SELECT record FROM entries").all().map((row) => JSON.parse(String(row.record))).filter((entry) => entry.kind === "runner.request").map((entry) => entry.data);
  } finally {
    db.close();
  }
}

// The faux model priced on output alone, $100 a million tokens: a request's least (1,024 tokens) is $0.1024. The faux
// harness books each of its requests at $0.001. Under the faux harness claude-agent and codex run one path.
test("a capped codex run's learned workflow is held to what the harness left of the cap: its node's request is refused when the harness's spend leaves less than its least", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
  // $0.103 less the harness's $0.001 leaves $0.102: not the node's $0.1024, which the cap alone would hold.
  const { runId, rows } = await ran(api, data, "capped-flow", "codex", flowFiles("answer", answerFlow()), [], { fields: { max_cost_usd: 0.103 } });
  const result = learnedResult(rows);
  assert.equal(result?.tool_status, "failed", JSON.stringify(result));
  assert.match(JSON.stringify(result), /model_error/, JSON.stringify(result));
  assert.equal(entries(data, runId, ["agentrun.request_started"]).filter((entry) => entry.capRefused === true).length, 1, "the cap refused its node's request: its own start mark");
  assert.deepEqual(entries(data, runId, ["agentrun.request_started", "agentrun.request_cost"]).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL), [], "no learned request was sent");
});

test("a capped codex run's harness counts its learned workflow's cost: its next request is held to what is left after it", { timeout: 120_000 }, async (t) => {
  const { api, data } = await serve(t, { learning: "on", fauxHarness: FAUX_HARNESS, faux: OUTPUT_PRICED });
  const cap = 0.25;
  const { runId, rows } = await ran(api, data, "counted-flow", "codex", flowFiles("answer", answerFlow()), [], { fields: { max_cost_usd: cap } });
  assert.equal(learnedResult(rows)?.tool_status, "success", JSON.stringify(learnedResult(rows)));
  const side = entries(data, runId, ["agentrun.request_cost"]).filter((entry) => entry.request === LEARNED_WORKFLOW_TOOL).map((entry) => entry.usd);
  assert.equal(side.length, 1, JSON.stringify(side));
  assert.ok(side[0] >= 0.0002, `the learned request cost something: ${side[0]}`);
  const held = harnessRequests(data, runId).map((request) => request.heldUsd);
  assert.equal(held.length, 2, JSON.stringify(held));
  // The second is limited to what is left of the cap after the first ($0.001) and the learned request, to the token.
  const left = cap - 0.001 - side[0];
  assert.ok(held[1] <= left + 1e-9 && held[1] > left - 0.0001 - 1e-9, `the harness's next request held at ${held[1]}, what is left after the learned workflow's $${side[0]} is ${left}`);
});

test("a run whose harness would send a learned workflow's requests around the operator's gateway is not offered its learned workflows: the pin leaves each out and names why", { timeout: 60_000 }, async (t) => {
  const files = { ...flowFiles("answer", answerFlow()), ...flowFiles("other", answerFlow()) };
  const why = "a learned workflow's requests would not go through the gateway";
  const { pin } = await pinned(t, "gated", files, [], { workflowsOff: why });
  assert.deepEqual([pin.workflows, pin.workflows_left_out, pin.workflows_off], [undefined, ["answer", "other"], why], JSON.stringify(pin));
  assert.deepEqual(await learning.pinnedWorkflows(join(await scratch(t), "none"), pin), []);
});
