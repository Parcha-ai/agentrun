// A learned workflow's model node of a tier runs on the agent's model of that tier (AGENT_MODEL_FAST, AGENT_MODEL_STRONG)
// on the runner, on the run's one route and under its one cap: a request of the run's booking labelled learned_workflow,
// priced at its own model's price, never the session's. A tier the agent has no model of runs on the run's own model. pi,
// on an operator's gateway (a faux one on loopback), each model with its own price.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { LEARNED_WORKFLOW_TOOL } from "../dist/learned-workflow.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentFolderOf } from "../dist/files.js";
import { seedOf } from "../dist/learning.js";
import { entriesOf, git, resnap } from "./learn-support.mjs";
import { agent, answerFlow, follow, serve, withEnv } from "./support.mjs";

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
/** Each model's price, USD per million input, output, cache-read and cache-write tokens. */
const PRICES = { "gpt-run": [1, 2, 0.5], "gpt-fast": [10, 20, 5], "gpt-strong": [100, 200, 50] };
/** The gateway's usage on every answer: 10 tokens in, 2 out. */
const usdOf = (model) => (10 * PRICES[model][0] + 2 * PRICES[model][1]) / 1e6;

/** pi's turn calls the learned workflow once; the node's request submits its answer; anything else says done. */
const script = ({ body }) => {
  const tools = (body?.tools ?? []).map((tool) => tool?.name);
  const answered = (body?.input ?? []).some((item) => item?.type === "function_call_output");
  if (answered) return undefined;
  if (tools.includes("submit")) return { name: "submit", input: { value: { answer: 42 } } };
  if (tools.includes(LEARNED_WORKFLOW_TOOL)) return { name: LEARNED_WORKFLOW_TOOL, input: { name: "answer", input: { question: "What is six times seven?" } } };
  return undefined;
};

/** A pi run of agent `id` whose learned workflow's one node names `tier`, on a gateway serving `env`'s models: the
 *  gateway's requests, and the run's booked requests (runner.request, with each one's runner.turn). */
async function tiered(t, id, tier, env) {
  const gw = await startFauxGateway({ call: script, text: "done" });
  t.after(() => gw.close());
  const price = (model) => PRICES[model].join(",");
  withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL_API_KEY: ["not-a-secret", "gateway"].join("-"), AGENT_MODEL: "gpt-run", AGENT_MODEL_PRICE: price("gpt-run"), ...env(price) }, ["ANTHROPIC_BASE_URL", "OPENROUTER_API_KEY", "AGENT_MODEL_FAST", "AGENT_MODEL_FAST_PRICE", "AGENT_MODEL_STRONG", "AGENT_MODEL_STRONG_PRICE"].filter((name) => !(name in env(price))));
  const { api, data } = await serve(t, { learning: "on", faux: undefined });
  const flow = answerFlow();
  if (tier) flow.root.steps[0].tier = tier;
  assert.equal((await api("POST", "/agents", agent(id, { learning: true, harness: "pi", instructions: ASK }))).status, 201);
  await folderWith(data, id, flowFiles("answer", flow));
  // Capped: every request is admitted under the run's one cap, held at its model's price before it leaves.
  const started = await api("POST", `/agents/${id}/runs`, { input: { content: ASK }, max_cost_usd: 5 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  const { rows } = await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  const result = rows.find((row) => row.kind === "tool_result" && row.tool_name === LEARNED_WORKFLOW_TOOL);
  assert.equal(result?.tool_status, "success", JSON.stringify(rows.map((row) => [row.kind, row.tool_name, row.summary])));
  const records = await entriesOf({ data }, runId, ["runner.request", "runner.turn"]);
  const turnOf = (request) => records.find((entry) => entry.kind === "runner.turn" && entry.turn === request.turn);
  const booked = records.filter((entry) => entry.kind === "runner.request").map((request) => ({ host: request.host, usd: turnOf(request)?.usd, held: request.heldUsd }));
  const sent = gw.requests.map((request) => ({ model: request.body?.model, node: (request.body?.tools ?? []).some((tool) => tool?.name === "submit") }));
  return { sent, booked, view: (await api("GET", `/runs/${runId}`)).body };
}

const near = (a, b) => Math.abs(a - b) < 1e-12;

for (const [tier, model, name] of [["fast", "gpt-fast", "AGENT_MODEL_FAST"], ["strong", "gpt-strong", "AGENT_MODEL_STRONG"]]) {
  test(`a learned workflow's ${tier} node runs on the agent's ${tier} model (${name}) on the run's one route, booked at that model's own price under the run's cap`, { timeout: 120_000 }, async (t) => {
    const { sent, booked, view } = await tiered(t, `tier-${tier}`, tier, (price) => ({ [name]: model, [`${name}_PRICE`]: price(model) }));
    assert.deepEqual(sent.filter((one) => one.node).map((one) => one.model), [model], `the node's request asks the gateway for ${model}: ${JSON.stringify(sent)}`);
    assert.ok(sent.filter((one) => !one.node).every((one) => one.model === "gpt-run"), `pi's own requests stay on the run's model: ${JSON.stringify(sent)}`);
    const node = booked.filter((one) => one.host === LEARNED_WORKFLOW_TOOL);
    assert.equal(node.length, 1, JSON.stringify(booked));
    assert.ok(near(node[0].usd, usdOf(model)), `the node's request is booked at ${model}'s price: ${node[0].usd} vs ${usdOf(model)}`);
    assert.ok(typeof node[0].held === "number" && node[0].held >= node[0].usd, `and held under the run's cap at its price before it left: ${JSON.stringify(node[0])}`);
    const own = booked.filter((one) => one.host === undefined);
    assert.ok(own.length >= 2 && own.every((one) => near(one.usd, usdOf("gpt-run"))), `pi's own at the run's price: ${JSON.stringify(own)}`);
    assert.equal(view.status, "completed");
  });
}

test("a learned workflow's fast node, where the agent has no fast model, runs on the run's own model and is booked at its price", { timeout: 120_000 }, async (t) => {
  const { sent, booked } = await tiered(t, "tier-none", "fast", () => ({}));
  assert.deepEqual(sent.filter((one) => one.node).map((one) => one.model), ["gpt-run"], JSON.stringify(sent));
  const node = booked.filter((one) => one.host === LEARNED_WORKFLOW_TOOL);
  assert.equal(node.length, 1, JSON.stringify(booked));
  assert.ok(near(node[0].usd, usdOf("gpt-run")), `${node[0].usd}`);
});
