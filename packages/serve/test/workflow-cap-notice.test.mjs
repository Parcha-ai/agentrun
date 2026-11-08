// A workflow paused at its cap tells the owner's webhook once: run.needs_input with pending budget, keyed on the pause
// itself, so a pause at a decision before any model row is told too, never dropped for want of a row to key it on.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { CANARY as PARALLEL_CANARY } from "./fixtures/faux-parallel.mjs";
import { startServe } from "../dist/index.js";
import { client, flowAgent, follow, letGo, scratch, serve, withEnv } from "./support.mjs";

const FAUX_PARALLEL = new URL("./fixtures/faux-parallel.mjs", import.meta.url).pathname;
const KEYS = ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "PARALLEL_API_KEY", "AGENT_MODEL_BASE_URL", "AGENT_MODEL_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "AGENTRUN_TEST_FAUX_PARALLEL_CALLS", "AGENTRUN_SEAL_KEY", "AGENTRUN_SERVE_BUDGET_HOLD_MS"];
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

const PRICED = new URL("./fixtures/faux-workflow-priced.mjs", import.meta.url).pathname;

/** A map over the input's questions that collects a failed item, each one `llm` call node. */
const collectingLlm = () => ({
  v: 2, name: "each",
  schemas: {
    In: { type: "object", required: ["questions"], properties: { questions: { type: "array", items: { type: "string" } } } },
    Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
    Found: { type: "array" },
  },
  input: { schemaId: "In" },
  output: { schemaId: "Found", path: "found" },
  root: { node: "chain", steps: [{ node: "map", label: "each", itemsPath: "questions", as: "found", resultPath: "said", maxConcurrency: 2, onItemFailure: "collect", failedAs: "missed", body: { node: "call", label: "ask", via: "tool", tool: "llm", args: { prompt: "{item}" }, out: "Llm", as: "said", deadline_s: 60 } }] },
});

/** Two model nodes in a chain: under a $0.12 cap the first runs and the second waits; $0.15 is its least. */
const twoNodes = () => ({
  v: 2, name: "twice",
  schemas: { In: { type: "object", required: ["question"], properties: { question: { type: "string" } } }, Answer: { type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Answer", path: "answer" },
  root: { node: "chain", steps: [
    { node: "extract", label: "first", instructions: "Answer the question.", out: "Answer", as: "first" },
    { node: "extract", label: "second", instructions: "Answer the question again.", out: "Answer", as: "answer" },
  ] },
});

test("waits at the same cap are told once, and a refusal at a higher cap (a raise that did not cover the step) is told again", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SEAL_KEY: randomBytes(32).toString("base64") }, KEYS);
  const hook = await receiver(t);
  const { api } = await serve(t, { faux: PRICED });
  assert.equal((await api("PUT", "/settings/webhook", { url: hook.url })).status, 201);
  const told = (runId) => hook.got.filter((message) => message.type === "run.needs_input" && message.data.run_id === runId);
  // Two items of a map, both waiting at the $0.05 cap: one pause, one notice.
  assert.equal((await api("POST", "/agents", flowAgent("asks", collectingLlm(), { tools: ["llm"] }))).status, 201);
  const map = (await api("POST", "/agents/asks/runs", { input: { questions: ["one", "two"] }, max_cost_usd: 0.05 })).body.run_id;
  await follow(api, map, SETTLED, { deadlineMs: 60_000 });
  assert.equal((await api("GET", `/runs/${map}`)).body.pending?.kind, "budget");
  for (const end = Date.now() + 10_000; Date.now() < end && told(map).length === 0; ) await sleep(100);
  await sleep(1_500);
  assert.equal(told(map).length, 1, "two waits at one cap are one pause, told once");
  // A pause at $0.12, then a raise to $0.13 that its step still does not fit ($0.15 is its least): refused again at the
  // higher cap, it is a pause of its own, told again.
  assert.equal((await api("POST", "/agents", flowAgent("twice", twoNodes()))).status, 201);
  const chain = (await api("POST", "/agents/twice/runs", { input: { question: "What is six times seven?" }, max_cost_usd: 0.12 })).body.run_id;
  await follow(api, chain, SETTLED, { deadlineMs: 60_000 });
  for (const end = Date.now() + 10_000; Date.now() < end && told(chain).length === 0; ) await sleep(100);
  assert.equal(told(chain).length, 1, "the pause at $0.12, told");
  assert.equal((await api("PATCH", `/runs/${chain}`, { max_cost_usd: 0.13 })).status, 200);
  for (const end = Date.now() + 15_000; Date.now() < end && told(chain).length < 2; ) await sleep(100);
  await sleep(1_500);
  const run = (await api("GET", `/runs/${chain}`)).body;
  assert.deepEqual([run.status, run.pending?.kind, run.pending?.cap_usd, told(chain).length], ["input_required", "budget", 0.13, 2], JSON.stringify(run));
});

test("the watch of a paused workflow stats its pause each round and reads it only when it changed, and stops with the run's process and with the server", { timeout: 180_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SERVE_BUDGET_HOLD_MS: "3000" }, KEYS);
  const data = join(await scratch(t), "agents");
  const checks = [];
  const server = await startServe({ data, port: 0, faux: PRICED, drainTimeout: "5s", onPauseCheck: (runId, what) => void checks.push({ runId, what }) });
  let closed = false;
  t.after(() => (closed ? undefined : server.close()));
  const api = client(server.baseUrl, server.token);
  const count = (runId, what) => checks.filter((check) => check.runId === runId && check.what === what).length;
  assert.equal((await api("POST", "/agents", flowAgent("watched", twoNodes()))).status, 201);
  const start = async () => {
    const runId = (await api("POST", "/agents/watched/runs", { input: { question: "What is six times seven?" }, max_cost_usd: 0.12 })).body.run_id;
    await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
    for (const end = Date.now() + 5_000; Date.now() < end && count(runId, "read") === 0; ) await sleep(50);
    return runId;
  };
  // Paused, its process held for 3 s: each round stats the pause; the unchanged file is not read again.
  const held = await start();
  const [stats, reads] = [count(held, "stat"), count(held, "read")];
  await sleep(1_200);
  assert.deepEqual([count(held, "stat") > stats, count(held, "read")], [true, reads], "stat'ed each round, read once while it is unchanged");
  // Its process let go: the watch is over, with nothing more stat'ed or read.
  await letGo(data, held);
  const gone = [count(held, "stat"), count(held, "read")];
  await sleep(1_500);
  assert.deepEqual([count(held, "stat"), count(held, "read")], gone, "nothing after the process ended");
  // Another paused run, its process still held, when the server closes: nothing more after the close.
  const live = await start();
  await server.close();
  closed = true;
  const after = [count(live, "stat"), count(live, "read")];
  await sleep(1_500);
  assert.deepEqual([count(live, "stat"), count(live, "read")], after, "nothing after the server closed");
});

test("the watch of a paused workflow adds no abort listener per round: each round's wait takes its own back when its timer fires, so a long pause holds no more listeners than a short one", { timeout: 120_000 }, async (t) => {
  withEnv(t, { AGENTRUN_SERVE_BUDGET_HOLD_MS: "60000" }, KEYS);
  // Each live abort listener on each signal in this process (the server runs in it), kept by the signal's own add and
  // remove; one that fires goes with its signal's abort, so only signals not aborted are read.
  const listening = new Map();
  const { addEventListener: add, removeEventListener: remove } = EventTarget.prototype;
  Object.defineProperty(AbortSignal.prototype, "addEventListener", { configurable: true, writable: true, value(type, listener, options) {
    if (type === "abort" && listener) (listening.get(this) ?? listening.set(this, new Set()).get(this)).add(listener);
    return add.call(this, type, listener, options);
  } });
  Object.defineProperty(AbortSignal.prototype, "removeEventListener", { configurable: true, writable: true, value(type, listener, options) {
    if (type === "abort") listening.get(this)?.delete(listener);
    return remove.call(this, type, listener, options);
  } });
  t.after(() => {
    delete AbortSignal.prototype.addEventListener;
    delete AbortSignal.prototype.removeEventListener;
  });
  const counts = () => new Map([...listening].filter(([signal]) => !signal.aborted).map(([signal, set]) => [signal, set.size]));
  const { api } = await serve(t, { faux: PRICED });
  assert.equal((await api("POST", "/agents", flowAgent("listened", twoNodes()))).status, 201);
  const runId = (await api("POST", "/agents/listened/runs", { input: { question: "What is six times seven?" }, max_cost_usd: 0.12 })).body.run_id;
  await follow(api, runId, SETTLED, { deadlineMs: 60_000 });
  assert.equal((await api("GET", `/runs/${runId}`)).body.pending?.kind, "budget");
  // Paused, its process held: the watch goes round every half second.
  await sleep(1_000);
  const before = counts();
  await sleep(4_000);
  const grown = [...counts()].map(([signal, size]) => size - (before.get(signal) ?? 0));
  assert.ok(Math.max(0, ...grown) <= 1, `about eight rounds add no listeners to any signal: grown by ${JSON.stringify(grown.filter((n) => n > 0))}`);
  assert.equal((await api("POST", `/runs/${runId}/cancel`)).status, 202);
});
