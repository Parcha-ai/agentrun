// A workflow run's pause and resume on the runner (POST /runs/{id}/pause and /resume: a `pause` or `resume` command row
// the run's runner takes). Main's behaviour (runs.ts pause, pause.ts): what is in flight finishes, and nothing new starts
// while paused: no node start, no model request, no decision. On the runner a pause takes effect where the spend cap's
// park does (workflow-spec.ts parkOnRefusal): before the next model request, decision or call node's effect, the request
// is never sent, the run parks in a pause entry and lets its claim go. A resume command wakes it, and the workflow goes
// on from its journal: nothing sent before the pause is sent again, and nothing is booked twice.
//
// Through the real loop (startRunner over createWorkflowLoop and workflowSpecOf) on a real store, a scripted Messages
// origin: the first model node's agent makes two requests (a call of a tool it does not have, then its submit), the
// second node's one. The origin counts each request by node and step, and can hold one until the test lets it answer.
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
const { sendCommand } = await import("../dist/runner/commands.js");

const TIMING = { leaseMs: 1_000, renewEveryMs: 250, stopMarginMs: 300, pollMs: 20, commandPollMs: 30 };
/** Long enough for the runner to hand a command row to the loop (it polls every commandPollMs, 30 ms). */
const DELIVERED_MS = 600;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Output $100 a million, input free: every answer reports 10 output tokens, so each request books $0.001. */
const PRICED = Object.freeze({ id: "faux-priced", api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });
const PER_REQUEST = (10 * 100) / 1e6;
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

/** Two model nodes in a chain: `first` (its agent tries a tool, then submits) and `second`. */
const twoNodes = () => ({
  v: 2, name: "two",
  schemas: {
    In: { type: "object", required: ["question"], properties: { question: { type: "string" } } },
    N: { type: "object", required: ["n"], properties: { n: { type: "number" } } },
    Out: { type: "object", required: ["first", "second"], properties: { first: { type: "object" }, second: { type: "object" } } },
  },
  input: { schemaId: "In" },
  output: { schemaId: "N", path: "second" },
  root: { node: "chain", steps: [
    { node: "extract", label: "first", instructions: "FIRST-NODE: answer one.", out: "N", as: "first" },
    { node: "extract", label: "second", instructions: "SECOND-NODE: answer two.", out: "N", as: "second" },
  ] },
});

const sse = (events) => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const toolUse = (model, name, input) => sse([
  { type: "message_start", message: { id: "msg_0", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${name}`, name, input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } },
  { type: "message_stop" },
]);

/** The scripted origin: each request is counted under its step ("first.1", "first.2", "second.1"); `hold(step)` makes
 *  the next request of that step wait until `release(step)`, and `arrived(step)` resolves once one has. */
function scriptedOrigin() {
  const counts = { "first.1": 0, "first.2": 0, "second.1": 0 };
  const held = new Map();
  const arrivals = new Map();
  const stepOf = (text) => (text.includes("SECOND-NODE") ? "second.1" : text.includes("tool_result") ? "first.2" : "first.1");
  const fetch = async (_url, init = {}) => {
    const text = String(init.body ?? "{}");
    const body = JSON.parse(text);
    const step = stepOf(text);
    counts[step] += 1;
    arrivals.get(step)?.resolve();
    // Held until release(step) resolves the gate (and lets it go); a request sent after that is not held.
    const gate = held.get(step);
    if (gate) await gate.promise;
    if (step === "first.1") return toolUse(body.model, "look_around", {});
    return toolUse(body.model, "submit", { n: step === "first.2" ? 1 : 2 });
  };
  const defer = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };
  return {
    fetch, counts,
    hold(step) { held.set(step, defer()); },
    arrived(step) { const d = defer(); arrivals.set(step, d); return d.promise; },
    release(step) { held.get(step)?.resolve(); held.delete(step); },
    releaseAll() { for (const gate of held.values()) gate.resolve(); held.clear(); },
  };
}

/** run-1, a workflow run of twoNodes under a cap of $100 (room for every hold), on a runner whose model nodes go to
 *  `origin`. */
async function worldWith(t, origin) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-pause-"));
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
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: twoNodes() } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { question: "Go." }, title: "t", place: { mode: "runner" }, max_cost_usd: 100 } });
  const providerOf = () => ({
    modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"p"}`,
    policy: anthropicPolicy({ model: "faux-priced", tools: [] }),
    price: (_model, usage) => (usage.output ?? 0) * 100 / 1e6,
    capModel: PRICED, fetch: origin.fetch,
  });
  runner = startRunner({ store, createLoop: createWorkflowLoop(workflowSpecOf({ store, providerOf })), name: "runner-a", ...TIMING });
  return { server, store };
}

/** The run's row once `done` holds, or a failure naming what it was. */
async function rowWhen(server, done, what, ms = 30_000) {
  const from = Date.now();
  for (;;) {
    const row = await server.runs.get("run-1");
    if (done(row)) return row;
    if (["ended", "failed", "stopped"].includes(row.state) || Date.now() - from > ms) assert.fail(`${what}: the run is ${JSON.stringify({ state: row.state, runner: row.runner, summary: row.summary })}`);
    await sleep(20);
  }
}
const pausedRow = (row) => row.state === "parked" && row.runner === null;
const endedRow = (row) => ["ended", "failed", "stopped"].includes(row.state) && row.runner === null;
/** A pause or resume row, as the server writes it (runs-over-store.ts pauseOrResume). */
const send = (server, kind) => server.command("run-1", { kind, body: {} });

test("the control: a run never paused ends with each request sent once, its cost three requests'", async (t) => {
  const origin = scriptedOrigin();
  const { server } = await worldWith(t, origin);
  const row = await rowWhen(server, endedRow, "the run ends");
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.deepEqual(origin.counts, { "first.1": 1, "first.2": 1, "second.1": 1 });
  assert.equal(eight(row.costUsd), eight(3 * PER_REQUEST), `booked once each: ${row.costUsd}`);
});

test("a pause between two nodes: the run parks with no claim held before the second node's request is sent, and nothing more is booked", async (t) => {
  const origin = scriptedOrigin();
  origin.hold("first.2");
  const arrived = origin.arrived("first.2");
  const { server } = await worldWith(t, origin);
  await arrived;
  await send(server, "pause");
  await sleep(DELIVERED_MS);
  origin.release("first.2");
  const row = await rowWhen(server, pausedRow, "the run parks, paused");
  assert.match(row.summary ?? "", /paus/i, `in a pause's words: ${row.summary}`);
  await sleep(DELIVERED_MS);
  assert.deepEqual(origin.counts, { "first.1": 1, "first.2": 1, "second.1": 0 }, "the second node's request was never sent");
  assert.equal((await server.runs.get("run-1")).runner, null, "no claim held while paused");
});

test("a resume finishes it: each request sent once, and the run's cost is that of a run never paused", async (t) => {
  const origin = scriptedOrigin();
  origin.hold("first.2");
  const arrived = origin.arrived("first.2");
  const { server } = await worldWith(t, origin);
  await arrived;
  await send(server, "pause");
  await sleep(DELIVERED_MS);
  origin.release("first.2");
  await rowWhen(server, pausedRow, "the run parks, paused");
  await send(server, "resume");
  const row = await rowWhen(server, endedRow, "the resumed run ends");
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.deepEqual(origin.counts, { "first.1": 1, "first.2": 1, "second.1": 1 }, "each request once: nothing before the pause sent again");
  assert.equal(eight(row.costUsd), eight(3 * PER_REQUEST), `booked once each: ${row.costUsd}`);
});

test("a pause during a model node: the request in flight finishes and is booked once, the node's next request waits unsent, and on resume the node goes on from there", async (t) => {
  const origin = scriptedOrigin();
  origin.hold("first.1");
  const arrived = origin.arrived("first.1");
  const { server } = await worldWith(t, origin);
  await arrived;
  await send(server, "pause");
  await sleep(DELIVERED_MS);
  origin.release("first.1");
  await rowWhen(server, pausedRow, "the run parks, paused, inside its first node");
  await sleep(DELIVERED_MS);
  assert.deepEqual(origin.counts, { "first.1": 1, "first.2": 0, "second.1": 0 }, "the request in flight finished; the node's next one was never sent");
  await send(server, "resume");
  const row = await rowWhen(server, endedRow, "the resumed run ends");
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.deepEqual(origin.counts, { "first.1": 1, "first.2": 1, "second.1": 1 }, "the node went on from its next request: its first was not sent again");
  assert.equal(eight(row.costUsd), eight(3 * PER_REQUEST), `booked once each: ${row.costUsd}`);
});

test("a pause sent before the run starts: it parks with no request sent, and a resume runs it whole", async (t) => {
  const origin = scriptedOrigin();
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agentrun-wf-pause-early-"));
  const server = await openSqliteStore({ dataDir: dir, role: "server" });
  t.after(async () => {
    await server.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  await server.agents.create({ id: "agent-1", name: "Flow" }, { id: "rev-1", kind: "workflow", body: { workflow: twoNodes() } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { question: "Go." }, title: "t", place: { mode: "runner" }, max_cost_usd: 100 } });
  await send(server, "pause");
  const store = await openSqliteStore({ dataDir: dir, role: "runner" });
  const providerOf = () => ({
    modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"p"}`,
    policy: anthropicPolicy({ model: "faux-priced", tools: [] }), price: (_model, usage) => (usage.output ?? 0) * 100 / 1e6, capModel: PRICED, fetch: origin.fetch,
  });
  const runner = startRunner({ store, createLoop: createWorkflowLoop(workflowSpecOf({ store, providerOf })), name: "runner-a", ...TIMING });
  t.after(async () => {
    await runner.close();
    await store.close().catch(() => {});
  });
  await rowWhen(server, (row) => row.epoch >= 1 && pausedRow(row), "the run parks, paused, before its first step");
  assert.deepEqual(origin.counts, { "first.1": 0, "first.2": 0, "second.1": 0 }, "no request sent");
  await send(server, "resume");
  const row = await rowWhen(server, endedRow, "the resumed run ends");
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  assert.deepEqual(origin.counts, { "first.1": 1, "first.2": 1, "second.1": 1 });
  assert.equal(eight(row.costUsd), eight(3 * PER_REQUEST));
});

test("an agentic run's pause and resume rows are refused in main's words (runs.ts pause), and the run goes on", async (t) => {
  const { capRun } = await import("./adapter-pi-cap-support.mjs");
  const { row, server } = await capRun(t, {
    script: [{ say: "Done." }],
    runCap: { capUsd: () => undefined, modelOf: () => undefined },
    during: async (server) => {
      await server.command("run-1", { kind: "pause", body: {} });
      await server.command("run-1", { kind: "resume", body: {} });
    },
  });
  assert.equal(row.state, "ended", JSON.stringify({ state: row.state, summary: row.summary }));
  const rows = (await server.commands("run-1", 0)).filter((command) => command.kind === "pause" || command.kind === "resume");
  assert.deepEqual(rows.map((command) => [command.kind, command.refused]), [
    ["pause", "Only a workflow run pauses here: an agentic run's turn is stopped with POST /runs/{id}/stop."],
    ["resume", "Only a workflow run pauses here: an agentic run's turn is stopped with POST /runs/{id}/stop."],
  ]);
});

test("paused stays paused: a raise that wakes it is taken, and the run parks again without sending a request; a resume then finishes it", async (t) => {
  const origin = scriptedOrigin();
  origin.hold("first.2");
  const arrived = origin.arrived("first.2");
  const { server } = await worldWith(t, origin);
  await arrived;
  await send(server, "pause");
  await sleep(DELIVERED_MS);
  origin.release("first.2");
  const paused = await rowWhen(server, pausedRow, "the run parks, paused");
  // The raise wakes the run (a command row makes a parked run claimable): a new claim takes it and parks again.
  await sendCommand(server, "run-1", { kind: "raise", body: { capUsd: 200 } });
  await rowWhen(server, (row) => row.epoch > paused.epoch && pausedRow(row), "the woken run is claimed and parks again");
  await sleep(DELIVERED_MS);
  const row = await server.runs.get("run-1");
  assert.ok(pausedRow(row), `still paused: ${JSON.stringify({ state: row.state, runner: row.runner, summary: row.summary })}`);
  assert.deepEqual(origin.counts, { "first.1": 1, "first.2": 1, "second.1": 0 }, "the wake sent no request");
  await send(server, "resume");
  const ended = await rowWhen(server, endedRow, "the resumed run ends");
  assert.equal(ended.state, "ended");
  assert.deepEqual(origin.counts, { "first.1": 1, "first.2": 1, "second.1": 1 });
});
