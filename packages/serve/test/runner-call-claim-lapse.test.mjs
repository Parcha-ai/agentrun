// A workflow call node's effect cut by a lapsed claim, on the store's own clock (never by load): the engine admits a call
// node's effect before it dispatches it, and a claim that lapses while the call is in flight leaves it admitted and unknown.
// The next claim's resume reads it so and will not repeat it (dsl recovery/driver.ts FROZEN_EFFECT_UNKNOWN: "it will not
// be repeated"): the run ends failed in those words, the call is never sent twice, and nothing is booked twice. This is
// the custody rule a load-cut claim meets too (#1186's "failed at call-0", the flake this pins whatever caused it).
//
// Through the real loop: two runners on one store file and one injected clock. Runner A claims the run and its call's
// request is held at the origin; the clock moves past A's lease (A renews on a long interval, so it never renews here);
// runner B claims the run and resumes it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import { storeOn, T0 } from "./store-helpers.mjs";

const { startRunner } = await import("../dist/runner/runner.js");
const { createWorkflowLoop } = await import("../dist/runner/workflow-loop.js");
const { workflowSpecOf } = await import("../dist/runner/workflow-spec.js");

const PRICED = Object.freeze({ id: "faux-priced", api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });
/** The call's model request at its hold: its model's output ceiling at $100 a million (input free). */
const REQUEST_HOLD = (PRICED.outputCeiling * 100) / 1e6;
const LEASE_MS = 60_000;
/** A runner that never renews within the test: its first renewal is 55 s of real time away, and the test moves the
 *  store's clock past its lease within a second. */
const TIMING = { leaseMs: LEASE_MS, renewEveryMs: 55_000, stopMarginMs: 1_000, pollMs: 20, commandPollMs: 30 };
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

const oneCall = {
  v: 2, name: "one-call",
  schemas: { In: { type: "object", additionalProperties: true }, Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Llm", path: "c0" },
  root: { node: "call", label: "call-0", via: "tool", tool: "llm", args: { prompt: "CALL-ONE: say ok." }, out: "Llm", as: "c0", deadline_s: 120 },
};
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

test("a call node's effect cut by a lapsed claim: the next claim reads it unknown and will not repeat it; the run fails in those words, the call sent once, nothing booked twice", { timeout: 60_000 }, async (t) => {
  const clock = { now: T0 };
  const { store: server, file } = await storeOn(t, { clock });
  const { store: storeA } = await storeOn(t, { clock, file, role: "runner" });
  const { store: storeB } = await storeOn(t, { clock, file, role: "runner" });
  await server.agents.create({ id: "agent-1", name: "Calls" }, { id: "rev-1", kind: "workflow", body: { workflow: oneCall, tools: ["llm"] } });
  await server.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "t", place: { mode: "runner" }, max_cost_usd: 100 } });
  // The origin: the call's request is held until released; each request counted.
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
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]);
  };
  const providerOf = () => ({ modelId: "faux-priced", api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"l"}`, policy: anthropicPolicy({ model: "faux-priced", tools: [] }), price: (_m, u) => (u.output ?? 0) * 100 / 1e6, capModel: PRICED, fetch });
  const runnerA = startRunner({ store: storeA, createLoop: createWorkflowLoop(workflowSpecOf({ store: storeA, providerOf })), name: "runner-a", ...TIMING });
  t.after(() => { release(); return runnerA.close().catch(() => {}); });
  await reached;
  // Runner A's claim lapses on the store's clock while its call is in flight (admitted, its request held).
  clock.now += LEASE_MS + 1_000;
  const runnerB = startRunner({ store: storeB, createLoop: createWorkflowLoop(workflowSpecOf({ store: storeB, providerOf })), name: "runner-b", ...TIMING });
  t.after(() => runnerB.close().catch(() => {}));
  const from = Date.now();
  let row;
  for (;;) {
    row = await server.runs.get("run-1");
    if (row.state === "failed" || row.state === "ended") break;
    if (Date.now() - from > 30_000) assert.fail(`the run never ended: ${JSON.stringify({ state: row.state, runner: row.runner, epoch: row.epoch })}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  release();
  const text = ["", "-wal"].map((suffix) => `${file}${suffix}`).filter(existsSync).map((name) => readFileSync(name).toString("utf8")).join("\n");
  assert.equal(row.state, "failed", `the resumed run fails at the unknown call: ${JSON.stringify({ state: row.state, summary: row.summary, epoch: row.epoch })}`);
  assert.ok(text.includes("FROZEN_EFFECT_UNKNOWN"), "in the engine's own words: the effect is unknown and will not be repeated");
  assert.equal(sent, 1, "the call was sent once, never repeated by the next claim");
  // Its request was sent and its answer lost with A's claim: it counts at its hold (the model's output ceiling at its
  // price), as a sent request whose outcome is unknown does, never $0 and never twice.
  assert.equal(eight(row.costUsd ?? 0), eight(REQUEST_HOLD), `booked once, at the lost request's hold: ${row.costUsd}`);
});
