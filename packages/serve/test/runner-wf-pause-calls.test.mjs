// A workflow run of call nodes pauses where main's does: before a call node's effect starts (main's pause.ts gate before a
// call's admission). A call node already running finishes, its outside call included; the next one is never admitted
// while paused, and a resume runs it once. A model request made inside a running call node is not where a pause lands:
// the call is in flight, and parking there would leave its effect admitted and unknown, which the engine refuses to
// resume (FROZEN_EFFECT_UNKNOWN).
//
// Through the real loop (startRunner over createWorkflowLoop and workflowSpecOf) on a real store: three `llm` call nodes in
// a chain, each one request to a scripted Messages origin that counts them by node and can hold one.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";

const { openSqliteStore } = await import("../dist/store/index.js");
const { startRunner } = await import("../dist/runner/runner.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { workflowSpecOf } = await import("../dist/runner/workflow-spec.js");

const TIMING = { leaseMs: 1_000, renewEveryMs: 250, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
/** Long enough for the runner to hand a command row to the loop (it polls every commandPollMs, 30 ms). */
const DELIVERED_MS = 600;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PRICED = Object.freeze({ id: "faux-priced", api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });
const NODES = ["CALL-ONE", "CALL-TWO", "CALL-THREE"];

/** Three `llm` call nodes in a chain. */
const threeCalls = () => ({
  v: 2, name: "three-calls",
  schemas: { In: { type: "object", additionalProperties: true }, Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
  input: { schemaId: "In" },
  output: { schemaId: "Llm", path: "c2" },
  root: { node: "chain", steps: NODES.map((word, index) => ({ node: "call", label: `call-${index}`, via: "tool", tool: "llm", args: { prompt: `${word}: say ok.` }, out: "Llm", as: `c${index}`, deadline_s: 120 })) },
});

const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const said = (model, text) => sse([
  { type: "message_start", message: { id: "msg_0", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
  { type: "message_stop" },
]);

/** The origin: each request counted under its node's word; `hold(word)` makes that node's request wait until
 *  `release(word)`, and `arrived(word)` resolves once it has come. */
function scriptedOrigin() {
  const counts = Object.fromEntries(NODES.map((word) => [word, 0]));
  const held = new Map();
  const arrivals = new Map();
  const defer = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };
  const fetch = async (_url, init = {}) => {
    const text = String(init.body ?? "{}");
    const body = JSON.parse(text);
    const word = NODES.find((one) => text.includes(one)) ?? "unknown";
    counts[word] = (counts[word] ?? 0) + 1;
    arrivals.get(word)?.resolve();
    const gate = held.get(word);
    if (gate) await gate.promise;
    return said(body.model, "ok");
  };
  return {
    fetch, counts,
    hold(word) { held.set(word, defer()); },
    arrived(word) { const d = defer(); arrivals.set(word, d); return d.promise; },
    release(word) { held.get(word)?.resolve(); held.delete(word); },
    releaseAll() { for (const gate of held.values()) gate.resolve(); held.clear(); },
  };
}

async function worldWith(t, origin) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-pause-calls-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  let runner;
  t.after(async () => {
    origin.releaseAll();
    await runner?.close();
    await store.close().catch(() => {});
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Calls" }, { id: "rev-1", kind: "workflow", body: { workflow: threeCalls(), tools: ["llm"] } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "t", place: { mode: "runner" }, max_cost_usd: 100 } });
  const providerOf = () => ({
    modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"c"}`,
    policy: anthropicPolicy({ model: "faux-priced", tools: [] }), price: (_model, usage) => (usage.output ?? 0) * 100 / 1e6, capModel: PRICED, fetch: origin.fetch,
  });
  runner = startRunner({ store, createLoop: createWorkflowLoop(workflowSpecOf({ store, providerOf })), name: "runner-a", ...TIMING });
  return { server };
}

/** The run's row once `done` holds; a run that ends first, or `ms` passing, fails it. `stop`: a wait another event won
 *  ends here, quietly. */
async function rowWhen(server, done, what, ms = 30_000, stop) {
  const from = Date.now();
  for (;;) {
    if (stop?.aborted) return undefined;
    const row = await server.runs.get("run-1");
    if (done(row)) return row;
    if (["ended", "failed", "stopped"].includes(row.state) || Date.now() - from > ms) assert.fail(`${what}: the run is ${JSON.stringify({ state: row.state, runner: row.runner, summary: row.summary })}`);
    await sleep(20);
  }
}
const pausedRow = (row) => row.state === "parked" && row.runner === null;
const endedRow = (row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null;

test("the control: three call nodes, never paused, each run once and the run ends", async (t) => {
  const origin = scriptedOrigin();
  const { server } = await worldWith(t, origin);
  const row = await rowWhen(server, endedRow, "the run ends");
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.deepEqual(origin.counts, { "CALL-ONE": 1, "CALL-TWO": 1, "CALL-THREE": 1 });
});

test("a pause during call node 1: it finishes, call node 2 does not start until the resume, and each node runs once", async (t) => {
  const origin = scriptedOrigin();
  origin.hold("CALL-ONE");
  const arrived = origin.arrived("CALL-ONE");
  const { server } = await worldWith(t, origin);
  // Call node 1's request reaches the origin; a run that fails first is told, never waited on.
  const watch = new AbortController();
  await Promise.race([arrived, rowWhen(server, () => false, "call node 1's request never came", 30_000, watch.signal)]);
  watch.abort();
  await server.command("run-1", { kind: "pause", body: {} });
  await sleep(DELIVERED_MS);
  origin.release("CALL-ONE");
  await rowWhen(server, pausedRow, "the run parks, paused, after call node 1");
  await sleep(DELIVERED_MS);
  assert.deepEqual(origin.counts, { "CALL-ONE": 1, "CALL-TWO": 0, "CALL-THREE": 0 }, "call node 1 finished; call node 2 never started");
  await server.command("run-1", { kind: "resume", body: {} });
  const row = await rowWhen(server, endedRow, "the resumed run ends");
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.deepEqual(origin.counts, { "CALL-ONE": 1, "CALL-TWO": 1, "CALL-THREE": 1 }, "each call node once");
});
