// A run's max_cost_usd, checked in the run's own process before each model request: what the run has spent plus the
// request's worst case (its input at the model's input price, its max output tokens at the output price) must stay
// within the cap, or the request is not sent. The server's check after each response stays as a backstop, and keeps
// the answer it stopped. A run's cost and /usage are never null for a run that made no request.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "@parcha/pi-durable-agent";
import { startServe } from "../dist/index.js";
import { agent, client, follow, responsesEndpoint, scratch, serve, storeRun, withEnv } from "./support.mjs";

const GATEWAY_VARS = ["AGENT_MODEL_BASE_URL", "AGENT_MODEL", "AGENT_MODEL_PRICE", "AGENT_MODEL_API_KEY"];
/** The gateway models' max output tokens (model.ts), which the requests below send as max_output_tokens. */
const GATEWAY_MAX_OUTPUT = 32_000;
const FAUX_MAX_OUTPUT = 16_384;
const OUTPUT_PRICED = new URL("./fixtures/faux-output-priced.mjs", import.meta.url).pathname;

/** A server whose runs go to a fresh Responses endpoint answering `text` with `tokens` each way, at `price`. */
async function gateway(t, { price, text = "42", tokens = 10 }) {
  const endpoint = await responsesEndpoint(t, text, tokens);
  withEnv(t, { AGENT_MODEL_BASE_URL: endpoint.url, AGENT_MODEL: "cap-model", AGENT_MODEL_PRICE: price }, GATEWAY_VARS);
  const server = await serve(t, { faux: undefined });
  const posts = () => endpoint.asked.filter((line) => line.startsWith("POST ")).length;
  return { ...server, endpoint, posts };
}

/** Start a run of a new agent `id` with `content` and `extra` run fields; the started run's view. */
async function start(api, id, content, extra = {}, definition = {}) {
  assert.equal((await api("POST", "/agents", agent(id, definition))).status, 201);
  const started = await api("POST", `/agents/${id}/runs`, { input: { content }, ...extra });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return started.body;
}

const ended = async (api, runId, until = ["completed", "failed", "cancelled"]) => {
  await follow(api, runId, until);
  return (await api("GET", `/runs/${runId}`)).body;
};

test("a request whose worst case alone passes max_cost_usd is never sent: the run ends failed with spend_cap_reached at $0", async (t) => {
  // $1 per million each way: the request's 32k max output tokens alone are $0.032, over a $0.01 cap.
  const { api, posts } = await gateway(t, { price: "1,1" });
  const run = await ended(api, (await start(api, "capped", "What is six times seven?", { max_cost_usd: 0.01 })).run_id);
  assert.equal(posts(), 0, "the gateway got no request");
  assert.deepEqual([run.status, run.error?.code], ["failed", "spend_cap_reached"], JSON.stringify(run));
  assert.equal(run.cost.usd, 0);
  assert.equal(run.result, null, "no answer was paid for");
});

test("the worst case is the request's max output tokens at the model's output price, plus its input at the input price", async (t) => {
  // Output only, $1 per million: the worst case is exactly the max output tokens' price.
  const { api, endpoint, posts } = await gateway(t, { price: "0,1" });
  const worst = GATEWAY_MAX_OUTPUT / 1e6;
  const above = await ended(api, (await start(api, "above", "What is six times seven?", { max_cost_usd: worst * 1.01 })).run_id);
  assert.deepEqual([above.status, posts()], ["completed", 1], JSON.stringify(above));
  assert.equal(endpoint.bodies[0].max_output_tokens, GATEWAY_MAX_OUTPUT, "the request's own max output tokens are the ones priced");
  const below = await ended(api, (await start(api, "below", "What is six times seven?", { max_cost_usd: worst * 0.99 })).run_id);
  assert.deepEqual([below.status, below.error?.code, posts()], ["failed", "spend_cap_reached", 1], JSON.stringify(below));
});

test("the worst case prices the request's input: at $0 output, an input that passes the cap is not sent", async (t) => {
  const { api, posts } = await gateway(t, { price: "1,0" });
  const run = await ended(api, (await start(api, "input", "What is six times seven?", { max_cost_usd: 1e-9 })).run_id);
  assert.deepEqual([run.status, run.error?.code, posts()], ["failed", "spend_cap_reached", 0], JSON.stringify(run));
});

/** A run that asks the person (one paid request, the ask) and then waits; its cost so far, and its cap for the next
 *  request: the worst case of one request plus half of what the first cost, so the second fits alone but not after it. */
async function asked(t) {
  const server = await serve(t, { faux: OUTPUT_PRICED });
  const probe = await start(server.api, "probe", "Pick a region.", {}, { tools: ["ask_person"] });
  await follow(server.api, probe.run_id, ["input_required"]);
  const first = (await server.api("GET", `/runs/${probe.run_id}`)).body.cost.usd;
  assert.ok(first > 0, "the ask was paid for");
  const cap = (FAUX_MAX_OUTPUT * 100) / 1e6 + first / 2;
  const run = await start(server.api, "region", "Pick a region.", { max_cost_usd: cap }, { tools: ["ask_person"] });
  await follow(server.api, run.run_id, ["input_required"]);
  return { ...server, runId: run.run_id, first };
}

test("spent so far counts the run's earlier requests: a request that fits alone is not sent once the run has spent too much", async (t) => {
  const { api, runId, first } = await asked(t);
  assert.equal((await api("POST", `/runs/${runId}/messages`, { content: "eu" })).body.mode, "answer");
  const run = await ended(api, runId);
  assert.deepEqual([run.status, run.error?.code], ["failed", "spend_cap_reached"], JSON.stringify(run));
  assert.equal(run.cost.usd, first, "only the ask was paid for");
});

test("a request the cap refuses never reaches the model: the run's second request, its input alone over the cap, is not made", async (t) => {
  const calls = join(await scratch(t), "calls.jsonl");
  withEnv(t, { AGENTRUN_TEST_FAUX_CALLS: calls });
  const { api } = await serve(t, { faux: new URL("./fixtures/faux-recorded.mjs", import.meta.url).pathname });
  // The ask is small and cheap; the answer's 20,000 characters (about 5,700 tokens at $100 per million) pass $0.2 alone.
  const run = await start(api, "region", "Pick a region.", { max_cost_usd: 0.2 }, { tools: ["ask_person"] });
  await follow(api, run.run_id, ["input_required"]);
  assert.equal((await api("POST", `/runs/${run.run_id}/messages`, { content: "eu ".repeat(6_666) })).body.mode, "answer");
  const view = await ended(api, run.run_id);
  assert.deepEqual([view.status, view.error?.code], ["failed", "spend_cap_reached"], JSON.stringify(view));
  const made = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(made, [{ users: 1 }], "the model was called for the ask and never for the answer");
});

test("spent so far survives a restart of the run's process: it is read back from the run's store", async (t) => {
  const { api, data, runId, first } = await asked(t);
  const pid = JSON.parse(await readFile(join(data, "runs", runId, "run.json"), "utf8")).holder.pid;
  // SIGTERM: the process drains, releases the run and exits, as when its server stops; the answer opens it again.
  process.kill(pid, "SIGTERM");
  for (const end = Date.now() + 10_000; ; await new Promise((resolve) => setTimeout(resolve, 50))) {
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    assert.ok(Date.now() < end, "the run's process exited");
  }
  const sent = await api("POST", `/runs/${runId}/messages`, { content: "eu" });
  assert.equal(sent.body.mode, "answer", JSON.stringify(sent.body));
  const run = await ended(api, runId);
  assert.deepEqual([run.status, run.error?.code], ["failed", "spend_cap_reached"], JSON.stringify(run));
  assert.equal(run.cost.usd, first, "only the ask was paid for");
});

test("a response that costs more than its worst case is stopped by the server after it, and the answer it paid for is kept", async (t) => {
  // A gateway that reports a million tokens each way, far past the 32k it was asked for: $2, over the $0.05 cap.
  const { api, posts } = await gateway(t, { price: "1,1", text: "The answer is 42.", tokens: 1_000_000 });
  const run = await ended(api, (await start(api, "over", "What is six times seven?", { max_cost_usd: 0.05 })).run_id);
  assert.deepEqual([run.status, run.error?.code, posts()], ["failed", "spend_cap_reached", 1], JSON.stringify(run));
  assert.equal(run.cost.usd, 2);
  assert.deepEqual(run.result, { output: null, final_answer: "The answer is 42." }, "the answer the cap stopped is kept");
});

const GROUPS = ["meter", "agent", "key", "day", "region"];
/** /usage for every grouping: its total and each line's usd. */
const usages = async (api) => Promise.all(GROUPS.map(async (group) => (await api("GET", `/usage?group_by=${group}`)).body));

test("a cancelled run is priced from its usage rows, never null, and /usage stays priced with it", async (t) => {
  const { api, data } = await serve(t, { faux: OUTPUT_PRICED });
  const paid = await ended(api, (await start(api, "paid", "What is six times seven?")).run_id);
  assert.ok(paid.cost.usd > 0);
  // One cancelled while its first request is still answering, one before it made any.
  const slow = await start(api, "slow", "Take your time.");
  await follow(api, slow.run_id, ["working"]);
  await api("POST", `/runs/${slow.run_id}/cancel`);
  const early = await start(api, "early", "Take your time.");
  await api("POST", `/runs/${early.run_id}/cancel`);
  for (const id of [slow.run_id, early.run_id]) {
    const run = await ended(api, id, ["cancelled"]);
    assert.equal(typeof run.cost.usd, "number", JSON.stringify(run.cost));
    assert.equal(storeRun(data, id).costUsd, run.cost.usd, "the store records the cost it carried back");
    const listed = (await api("GET", `/runs?agent=${run.agent_id}`)).body.runs[0];
    assert.equal(typeof listed.cost.usd, "number", JSON.stringify(listed.cost));
  }
  for (const usage of await usages(api)) {
    assert.ok(Math.abs(usage.total_usd - paid.cost.usd) < 1e-9, JSON.stringify(usage));
    assert.ok(usage.lines.every((line) => typeof line.usd === "number"), JSON.stringify(usage));
  }
});

test("a run costs $0 until its first response, not null", async (t) => {
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const go = join(await scratch(t), "go");
  const run = await start(api, "waits", `Answer once ${go} exists.`);
  await follow(api, run.run_id, ["working"]);
  assert.equal((await api("GET", `/runs/${run.run_id}`)).body.cost.usd, 0);
  await writeFile(go, "");
  assert.equal((await ended(api, run.run_id)).status, "completed");
});

test("/usage sums the runs whose cost is known: one run with no recorded cost does not make a total or a line null", async (t) => {
  const data = join(await scratch(t), "agents");
  const one = await startServe({ data, port: 0, faux: OUTPUT_PRICED });
  const first = client(one.baseUrl, one.token);
  const paid = await ended(first, (await start(first, "paid", "What is six times seven?")).run_id);
  await one.close();
  // A run an earlier server carried back without a cost.
  const store = openStore(data);
  try {
    const { runId } = await store.startRun({ agent: "paid" });
    store.carryBack(runId, { state: "failed", summary: "no cost recorded" });
  } finally {
    store.close();
  }
  const two = await startServe({ data, port: 0, faux: OUTPUT_PRICED });
  t.after(() => two.close());
  const api = client(two.baseUrl, two.token);
  for (const usage of await usages(api)) {
    assert.ok(Math.abs(usage.total_usd - paid.cost.usd) < 1e-9, JSON.stringify(usage));
    assert.ok(usage.lines.every((line) => typeof line.usd === "number"), JSON.stringify(usage));
    assert.equal(usage.unpriced_runs, 1, "the run with no recorded cost is counted, not passed off as $0");
    assert.equal(usage.lines.reduce((n, line) => n + line.unpriced_runs, 0), 1);
  }
});

test("a response of unknown price leaves the run's cost unknown (null), not $0, and /usage counts it as unpriced; a run with no request costs $0", async (t) => {
  const { api } = await serve(t, { faux: new URL("./fixtures/faux-unpriced.mjs", import.meta.url).pathname });
  const run = await ended(api, (await start(api, "unpriced", "What is six times seven?")).run_id);
  assert.deepEqual([run.status, run.cost.usd], ["completed", null], JSON.stringify(run.cost));
  assert.equal((await api("GET", "/runs?agent=unpriced")).body.runs[0].cost.usd, null);
  const none = await start(api, "none", "Take your time.");
  await api("POST", `/runs/${none.run_id}/cancel`);
  assert.equal((await ended(api, none.run_id, ["cancelled"])).cost.usd, 0, "no request: $0");
  for (const usage of await usages(api)) {
    assert.deepEqual([usage.total_usd, usage.unpriced_runs], [0, 1], JSON.stringify(usage));
    assert.equal(usage.lines.reduce((n, line) => n + line.unpriced_runs, 0), 1, JSON.stringify(usage));
  }
});

test("a refused request is final: one refusal, never retried, and the model is never called for it", async (t) => {
  // $0.015625 per million output tokens and 32,000 of them: the worst case reads $0.000500, digits pi-ai's retry takes
  // for a server error unless the refusal says it is final.
  const { api, posts } = await gateway(t, { price: "0,0.015625" });
  const from = Date.now();
  const { run_id } = await start(api, "final", "What is six times seven?", { max_cost_usd: 0.0001 });
  const { rows } = await follow(api, run_id, ["failed"]);
  const run = (await api("GET", `/runs/${run_id}`)).body;
  assert.equal(run.error.code, "spend_cap_reached");
  assert.match(run.error.message, /\$0\.000500/, "the amount that reads as a 500");
  assert.equal(rows.filter((r) => r.kind === "error").length, 1, "one refusal: the request was not tried again");
  assert.equal(posts(), 0);
  assert.ok(Date.now() - from < 10_000, "no retry backoff");
});

test("a cap in the server's own environment never reaches a run that names none", async (t) => {
  withEnv(t, { AGENTRUN_SERVE_MAX_COST_USD: "0.000001" });
  const { api } = await serve(t, { faux: OUTPUT_PRICED });
  const run = await ended(api, (await start(api, "uncapped", "What is six times seven?")).run_id);
  assert.deepEqual([run.status, run.error, run.cost.cap_usd], ["completed", null, null], JSON.stringify(run));
});
