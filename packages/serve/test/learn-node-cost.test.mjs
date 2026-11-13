// A pi run's cost counts the requests its learned workflow's nodes make. A node's request is booked in the run's
// session as a side call (labelled learned_workflow), under the run's one cap, and none of pi's answers carries it: the
// run's view and its row read its whole booking, pi's answers and its nodes' requests, never pi's answers alone. pi, on
// an operator's gateway (a faux one on loopback), priced by AGENT_MODEL_PRICE. The fixture is tl-learning's (the learned
// workflow tiers' fallback run, three requests at $0.000014 each, which read $0.000028).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { LEARNED_WORKFLOW_TOOL } from "../dist/learned-workflow.js";
import { agentFolderOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import { entriesOf, git, resnap } from "./learn-support.mjs";
import { agent, answerFlow, follow, serve, storeRun, withEnv } from "./support.mjs";

/** A learned workflow's two files, as the merge keeps them. */
const flowFiles = (name, workflow) => ({
  [`workflows/${name}/workflow.json`]: JSON.stringify(workflow),
  [`workflows/${name}/README.md`]: `---\nname: ${name}\ndescription: Answers a question as a number; use when the person asks for the answer\n---\n`,
});
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

const ASK = "Use the learned workflow answer on What is six times seven.";
/** The run's model's price, USD per million input, output and cache-read tokens; the gateway's usage is 10 in, 2 out. */
const PRICE = [1, 2, 0.5];
const EACH = (10 * PRICE[0] + 2 * PRICE[1]) / 1e6;

/** pi's turn calls the learned workflow once; the node's request submits its answer; anything else says done. */
const script = ({ body }) => {
  const tools = (body?.tools ?? []).map((tool) => tool?.name);
  const answered = (body?.input ?? []).some((item) => item?.type === "function_call_output");
  if (answered) return undefined;
  if (tools.includes("submit")) return { name: "submit", input: { value: { answer: 42 } } };
  if (tools.includes(LEARNED_WORKFLOW_TOOL)) return { name: LEARNED_WORKFLOW_TOOL, input: { name: "answer", input: { question: "What is six times seven?" } } };
  return undefined;
};

test("a pi run's cost is its whole booking: its learned workflow node's request counts beside pi's own answers, on its view and its row", { timeout: 120_000 }, async (t) => {
  const gw = await startFauxGateway({ call: script, text: "done" });
  t.after(() => gw.close());
  withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL_API_KEY: ["not-a-secret", "gateway"].join("-"), AGENT_MODEL: "gpt-run", AGENT_MODEL_PRICE: PRICE.join(",") }, ["ANTHROPIC_BASE_URL", "OPENROUTER_API_KEY", "AGENT_MODEL_FAST", "AGENT_MODEL_FAST_PRICE", "AGENT_MODEL_STRONG", "AGENT_MODEL_STRONG_PRICE"]);
  const { api, data } = await serve(t, { learning: "on", faux: undefined });
  assert.equal((await api("POST", "/agents", agent("node-cost", { learning: true, harness: "pi", instructions: ASK }))).status, 201);
  await folderWith(data, "node-cost", flowFiles("answer", answerFlow()));
  const started = await api("POST", "/agents/node-cost/runs", { input: { content: ASK }, max_cost_usd: 5 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_name === LEARNED_WORKFLOW_TOOL);
  assert.equal(result?.tool_status, "success", JSON.stringify(rows.map((row) => [row.kind, row.tool_name, row.summary])));
  // The booking: pi's own answers and the node's one request, each at the run's price.
  const records = await entriesOf({ data }, runId, ["runner.request", "runner.turn"]);
  const turns = records.filter((entry) => entry.kind === "runner.turn");
  const node = records.filter((entry) => entry.kind === "runner.request" && entry.host === LEARNED_WORKFLOW_TOOL);
  assert.equal(node.length, 1, `the node's request is booked, labelled learned_workflow: ${JSON.stringify(records)}`);
  const booked = Math.round(turns.reduce((sum, turn) => sum + turn.usd, 0) * 1e9) / 1e9;
  assert.equal(booked, Math.round(turns.length * EACH * 1e9) / 1e9, `every request at the run's price: ${JSON.stringify(turns)}`);
  // The run's cost is that whole booking, the node's request included: on its view, its usage row and its row.
  const view = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(Math.round(view.cost.usd * 1e9) / 1e9, booked, `the view's cost counts the node's request: ${JSON.stringify(view.cost)}, booked ${booked} over ${turns.length} requests`);
  const usage = rows.findLast((row) => row.kind === "usage")?.usage;
  assert.deepEqual([Math.round((usage?.usd ?? 0) * 1e9) / 1e9, usage?.requests], [booked, turns.length], `its usage row: ${JSON.stringify(usage)}`);
  const stored = storeRun(data, runId);
  assert.equal(Math.round((stored?.costUsd ?? 0) * 1e9) / 1e9, booked, `its row's stored cost (the end's): ${JSON.stringify(stored)}`);
});
