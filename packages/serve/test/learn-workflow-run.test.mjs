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

/** Agent `id` on `harness`, learning, with `files` learned; one run of ASK, ended: its id, rows and view. */
async function ran(api, data, id, harness, files, tools = []) {
  assert.equal((await api("POST", "/agents", agent(id, { learning: true, harness, instructions: ASK, tools }))).status, 201);
  await folderWith(data, id, files);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: ASK } });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  return { runId, rows, view: (await api("GET", `/runs/${runId}`)).body };
}

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
