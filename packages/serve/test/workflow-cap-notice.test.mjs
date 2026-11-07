// A workflow paused at its cap tells the owner's webhook once: run.needs_input with pending budget, keyed on the pause
// itself, so a pause at a decision before any model row is told too, never dropped for want of a row to key it on.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { CANARY as PARALLEL_CANARY } from "./fixtures/faux-parallel.mjs";
import { flowAgent, follow, scratch, serve, withEnv } from "./support.mjs";

const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "PARALLEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "AGENTRUN_TEST_FAUX_PARALLEL_CALLS", "AGENTRUN_SEAL_KEY"];
const SETTLED = ["input_required", "completed", "failed", "cancelled"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One judge node on Parallel: a decision-only workflow, whose first request is the decision. */
const judgeFlow = () => ({
  v: 2, name: "judged",
  schemas: {
    In: { type: "object", required: ["doc"], properties: { doc: { type: "string" } } },
    Verdict: { type: "object", additionalProperties: false, required: ["is_coi"], properties: { is_coi: { type: "boolean", description: "Is `doc` a certificate of incorporation?" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Verdict", path: "verdict" },
  root: { node: "judge", label: "coi", provider: "parallel", state: { doc: "{doc}" }, out: "Verdict", as: "verdict" },
});

/** A webhook receiver on 127.0.0.1: each POST's parsed body. */
async function receiver(t) {
  const got = [];
  const path = `/hook/${randomBytes(8).toString("hex")}`;
  const server = createServer((req, res) => {
    if (req.url !== path) return void res.writeHead(404).end();
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => (got.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))), res.writeHead(200).end()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => (server.close(resolve), server.closeAllConnections())));
  return { url: `http://127.0.0.1:${server.address().port}${path}`, got };
}

test("a decision-only workflow paused at its cap before its first request tells the owner's webhook once: run.needs_input, pending budget", { timeout: 120_000 }, async (t) => {
  const calls = join(await scratch(t), "parallel-calls.jsonl");
  withEnv(t, { PARALLEL_API_KEY: PARALLEL_CANARY, AGENTRUN_TEST_FAUX_PARALLEL_CALLS: calls, AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, KEYS);
  const hook = await receiver(t);
  const { api } = await serve(t, { fauxParallel: FAUX_PARALLEL });
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  assert.equal((await api("POST", "/agents", flowAgent("judge-only", judgeFlow()))).status, 201);
  // Parallel's list price for one decision is $0.001: a $0.0005 cap has no room for the first request.
  const started = await api("POST", "/agents/judge-only/runs", { input: { doc: "Certificate of Incorporation of Example Widgets, Inc." }, max_cost_usd: 0.0005 });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const runId = started.body.run_id;
  await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
  const run = (await api("GET", `/runs/${runId}`)).body;
  assert.deepEqual([run.status, run.pending?.kind], ["input_required", "budget"], JSON.stringify(run));
  // Given time to be told (and to be told twice, were it told more than once).
  const told = () => hook.got.filter((message) => message.type === "run.needs_input" && message.data.run_id === runId);
  for (const end = Date.now() + 10_000; Date.now() < end && told().length === 0; ) await sleep(100);
  await sleep(1_500);
  assert.deepEqual(told().map((message) => [message.data.status, message.data.pending]), [["input_required", { kind: "budget" }]], "told once, as a pause at its cap");
});
