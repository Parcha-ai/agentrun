// A learned workflow's node the run's cap refuses for room parks the agentic run that called it, and the run stays parked
// until its cap is raised (walk 2408e, cap-ladder): its fast node ran, its untiered node was refused, and the run read
// input_required with a budget card; then pi's next request of the same turn went out under the cap, the model answered
// on its own ("The workflow failed, but ..."), and the run completed, so the raise was 409 not_continuable. One refused
// request parks the whole claim (adapter-loop.ts pauseAt, pendingPause, since #2493): pi's own next request is refused
// in the same words, nothing more is sent, and a raise resumes the run, whose follow-up turn runs the workflow again. pi,
// on an operator's gateway (a faux one on loopback), the fast node on a cheap model and the run's own model dearer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startFauxGateway } from "./fixtures/faux-gateway.mjs";
import { LEARNED_WORKFLOW_TOOL } from "../dist/learned-workflow.js";
import { landWorkflows } from "./learned-workflow-seed-support.mjs";
import { sleep } from "./learn-support.mjs";
import { agent, answerFlow, follow, serve, withEnv } from "./support.mjs";

const ASK = "Use the learned workflow answer on What is six times seven.";
/** Each model's price, USD per million input, output and cache-read tokens: the run's own model dearer than the fast one. */
const PRICES = { "gpt-run": [1, 2, 0.5], "gpt-fast": [0.1, 0.2, 0.05] };
/** Fits pi's own requests (each clamped to what is left) and the fast node's, never the untiered node's least on gpt-run:
 *  so pi's next request would go out if the park did not refuse it (with the claim-wide refusal taken out, it does: the
 *  run sends a third gpt-run request and completes on it). */
const CAP = 0.008;

/** pi calls the learned workflow on each message of the person's (the raise's follow-up included); each node's request
 *  submits its answer; a request after the call's result says done. */
const script = ({ body }) => {
  const tools = (body?.tools ?? []).map((tool) => tool?.name);
  if ((body?.input ?? []).at(-1)?.type === "function_call_output") return undefined;
  if (tools.includes("submit")) return { name: "submit", input: { value: { answer: 42 } } };
  if (tools.includes(LEARNED_WORKFLOW_TOOL)) return { name: LEARNED_WORKFLOW_TOOL, input: { name: "answer", input: { question: "What is six times seven?" } } };
  return undefined;
};

test("a learned workflow's node refused for room parks the run: pi's next request is refused too, nothing more is sent, the run stays parked, and a raise resumes it", { timeout: 180_000 }, async (t) => {
  const gw = await startFauxGateway({ call: script, text: "done" });
  t.after(() => gw.close());
  const price = (model) => PRICES[model].join(",");
  withEnv(t, { AGENT_MODEL_BASE_URL: gw.url, AGENT_MODEL_API_KEY: ["not-a-secret", "gateway"].join("-"), AGENT_MODEL: "gpt-run", AGENT_MODEL_PRICE: price("gpt-run"), AGENT_MODEL_FAST: "gpt-fast", AGENT_MODEL_FAST_PRICE: price("gpt-fast") }, ["ANTHROPIC_BASE_URL", "OPENROUTER_API_KEY", "AGENT_MODEL_STRONG", "AGENT_MODEL_STRONG_PRICE"]);
  const { api, data } = await serve(t, { learning: "on", faux: undefined });
  const id = "cap-park-node";
  const flow = answerFlow();
  flow.root.steps = [
    { node: "extract", label: "quick", tier: "fast", instructions: "Answer the question as a number.", out: "Answer", as: "quick" },
    { node: "extract", label: "answer", instructions: "Give the number in `quick` again.", out: "Answer", as: "answer" },
  ];
  assert.equal((await api("POST", "/agents", agent(id, { learning: true, harness: "pi", instructions: ASK }))).status, 201);
  await landWorkflows(data, id, [{ name: "answer", description: "Answers a question as a number; use when the person asks for the answer", workflow: flow }]);
  /** Each request the gateway took: its model, and ":node" for a workflow node's (it offers submit). */
  const sent = () => gw.requests.map((request) => `${request.body?.model}${(request.body?.tools ?? []).some((tool) => tool?.name === "submit") ? ":node" : ""}`);

  const started = await api("POST", `/agents/${id}/runs`, { input: { content: ASK }, max_cost_usd: CAP });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, ["input_required", "completed", "failed"], { deadlineMs: 60_000 });
  const parked = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([parked.status, parked.state, parked.pending?.kind], ["input_required", "waiting", "budget"], JSON.stringify(parked));
  assert.deepEqual(sent(), ["gpt-run", "gpt-fast:node"], "pi's first request and the fast node went; the untiered node was refused, unsent");

  // The park holds: the claim lets the run go parked, never answering on pi's next request. Without the claim-wide
  // refusal, that request went out under the cap and the run completed on the model's own answer.
  const deadline = Date.now() + 60_000;
  let after = parked;
  while (after.claim && Date.now() < deadline) {
    await sleep(250);
    after = (await api("GET", `/runs/${runId}`)).body;
  }
  assert.equal(after.claim, null, `the parked run's claim was let go: ${JSON.stringify(after.claim)}`);
  assert.deepEqual([after.status, after.state, after.pending?.kind], ["input_required", "waiting", "budget"], `still parked: ${JSON.stringify({ status: after.status, result: after.result, cost: after.cost })}`);
  assert.deepEqual(sent(), ["gpt-run", "gpt-fast:node"], "nothing more was sent once the run parked");
  assert.ok(after.cost.usd <= CAP, `within its cap: ${JSON.stringify(after.cost)}`);

  const raised = await api("PATCH", `/runs/${runId}`, { max_cost_usd: 1 });
  assert.deepEqual([raised.status, raised.body.resumed], [200, true], JSON.stringify(raised.body));
  await follow(api, runId, ["completed", "failed"], { deadlineMs: 60_000 });
  const done = (await api("GET", `/runs/${runId}`)).body;
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.ok(sent().includes("gpt-run:node"), `the untiered node ran on the run's own model once raised: ${JSON.stringify(sent())}`);
});
