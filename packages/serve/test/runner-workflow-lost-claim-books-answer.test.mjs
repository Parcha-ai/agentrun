// A workflow run's model request that answers after its runner's claim lapsed, the same runner taking the run again: the
// lost claim's booking saw the answer and its usage, but the run's journal refused its runner.turn (the claim had moved
// on). The workflow's booking is scoped by the claim's runner and run (journalSessions' SessionWriter.scope), so the
// refused booking is handed to the next claim of the same runner, which books it at its bookCut, before the workflow
// resumes, at what the request reported: never cut at an unknown cost, never left counted at its hold.
//
// Through the real loop, as runner-call-claim-lapse.test.mjs: one store file, one injected clock, two runner instances
// under the same runner's name (its claim lost and taken again in this process). The call's request is held at the origin;
// the clock moves past the first claim's lease; the second claims the run at the next epoch; the origin answers.
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import { RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import { journalOf } from "./support.mjs";
import { storeOn, T0 } from "./store-helpers.mjs";
import { onPostgres } from "./store-target.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { workflowSpecOf } = await import("../dist/runner/workflow-spec.js");

const PRICED = Object.freeze({ id: "faux-priced", api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });
/** The request's hold: its model's output ceiling at $100 a million (input free). */
const REQUEST_HOLD = (PRICED.outputCeiling * 100) / 1e6;
/** What the request reports: 10 output tokens at $100 a million. */
const OUTPUT_TOKENS = 10;
const REPORTED_USD = (OUTPUT_TOKENS * 100) / 1e6;
const LEASE_MS = 60_000;
const TIMING = { leaseMs: LEASE_MS, renewEveryMs: 55_000, stopMarginMs: 1_000, pollMs: 20, commandPollMs: 30 };
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

const oneCall = {
  v: 2, name: "one-call",
  schemas: { In: { type: "object", additionalProperties: true }, Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Llm", path: "c0" },
  root: { node: "call", label: "call-0", via: "tool", tool: "llm", args: { prompt: "CALL-ONE: say ok." }, out: "Llm", as: "c0", deadline_s: 120 },
};
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

test("a workflow's model request that answers after its claim lapsed is booked at what it reported by the same runner's next claim", { timeout: 60_000 }, async (t) => {
  const clock = { now: T0 };
  const { store: server, file } = await storeOn(t, { clock });
  const { store: first } = await storeOn(t, { clock, file, role: "runner" });
  const { store: again } = await storeOn(t, { clock, file, role: "runner" });
  await server.agents.create({ id: "agent-1", name: "Calls" }, { id: "rev-1", kind: "workflow", body: { workflow: oneCall, tools: ["llm"] } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "t", place: { mode: "runner" }, max_cost_usd: 100 } });
  let sent = 0;
  let arrived;
  const reached = new Promise((resolve) => (arrived = resolve));
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const fetch = async (_url, init = {}) => {
    sent += 1;
    arrived();
    await released;
    const body = JSON.parse(String(init.body ?? "{}"));
    return sse([
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: OUTPUT_TOKENS } },
      { type: "message_stop" },
    ]);
  };
  const providerOf = () => ({ modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"w"}`, policy: anthropicPolicy({ model: "faux-priced", tools: [] }), price: (_m, u) => (u.output ?? 0) * 100 / 1e6, capModel: PRICED, fetch });
  const lost = startRunner({ store: first, createLoop: createWorkflowLoop(workflowSpecOf({ store: first, providerOf })), name: "runner-a", ...TIMING });
  t.after(() => { release(); return lost.close().catch(() => {}); });
  await reached;
  // The first claim lapses on the store's clock while its request is out; the same runner takes the run at the next epoch.
  clock.now += LEASE_MS + 1_000;
  const taker = startRunner({ store: again, createLoop: createWorkflowLoop(workflowSpecOf({ store: again, providerOf })), name: "runner-a", ...TIMING });
  t.after(() => taker.close().catch(() => {}));
  const from = Date.now();
  while ((await server.runs.get("run-1")).epoch !== 2) {
    if (Date.now() - from > 20_000) assert.fail("the run was never taken again");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The request answers now: the lost claim's write of its cost is refused, the run's claim having moved on.
  release();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (row.state === "failed" || row.state === "ended") break;
    if (Date.now() - from > 40_000) assert.fail(`the run never ended: ${JSON.stringify({ state: row.state, epoch: row.epoch })}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await lost.close().catch(() => {});
  await taker.close().catch(() => {});
  assert.equal(sent, 1, "the request was sent once");
  assert.equal(eight(row.costUsd ?? -1), eight(REPORTED_USD), `the run's cost is the request's reported cost, never its hold (${REQUEST_HOLD}): ${row.costUsd}`);
  if (onPostgres) return;
  // Its record, booked once, at what it reported (the journal read here is SQLite's file).
  // The model request's own session (the call's hold, on the run's paid-tools session, is booked apart).
  const entries = journalOf(dirname(file), "run-1");
  const session = entries.find((e) => e.kind === RUNNER_RECORDS.request && e.data?.model === PRICED.id)?.conversationId;
  assert.notEqual(session, undefined, "the request was admitted on the run's model session");
  const turns = entries.filter((e) => e.conversationId === session && e.kind === RUNNER_RECORDS.turn).map((e) => e.data);
  assert.equal(turns.length, 1, `booked once: ${JSON.stringify(turns)}`);
  assert.equal(turns[0].cut, undefined, `never cut: ${JSON.stringify(turns[0])}`);
  assert.equal(eight(turns[0].usd), eight(REPORTED_USD), `at what it reported: ${JSON.stringify(turns[0])}`);
});
