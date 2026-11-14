// A workflow run's model request that answers after its runner's claim lapsed, the same runner taking the run again: the
// lost claim's booking saw the answer and its usage, but the run's journal refused its runner.turn (the claim had moved
// on). The workflow's booking is scoped by the claim's runner and run (journalSessions' SessionWriter.scope), so the
// refused booking is handed to the next claim of the same runner, which books it at its bookCut (workflowSpecOf's
// harnessReady), before the workflow resumes, at what the request reported: never cut at an unknown cost, never left
// counted at its hold.
//
// Driven claim by claim, as runner-lost-claim-books-answer.test.mjs drives the run loop's booking: the store claims the
// run, workflowSpecOf builds the claim's spec and its harnessReady wires the booking on a Harness over the claim's
// journal (as the workflow loop does), and the request goes out through that claim's own model proxy. The store's clock
// moves past the lease, the same runner claims the run at epoch 2, and the second claim's harnessReady books what the
// first could not. No runner polls and no wall-clock budget is waited on: every wait is on the request reaching the
// origin, a claim returned, or a promise of the path itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { anthropicPolicy } from "@parcha/agentrun-harness-claude";
import { RUNNER_RECORDS, sessionSpendOf } from "@parcha/agentrun-kernel";
import { storeOn, T0 } from "./store-helpers.mjs";

const { workflowSpecOf } = await import("../dist/runner/workflow-spec.js");
const { journalSessions } = await import("../dist/runner/sessions.js");
const { WORKFLOW_SESSION } = await import("../dist/runner/journal-kinds.js");

const ctx = BACKGROUND_CONTEXT;
const PRICED = Object.freeze({ id: "faux-priced", api: "anthropic-messages", price: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 }, outputCeiling: 16_384 });
/** The request's hold: its model's output ceiling at $100 a million (input free). */
const REQUEST_HOLD = (PRICED.outputCeiling * 100) / 1e6;
/** What the request reports: 10 output tokens at $100 a million. */
const OUTPUT_TOKENS = 10;
const REPORTED_USD = (OUTPUT_TOKENS * 100) / 1e6;
const LEASE_MS = 60_000;
const eight = (usd) => Math.round(usd * 1e8) / 1e8;

const oneCall = {
  v: 2, name: "one-call",
  schemas: { In: { type: "object", additionalProperties: true }, Llm: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
  input: { schemaId: "In" }, output: { schemaId: "Llm", path: "c0" },
  root: { node: "call", label: "call-0", via: "tool", tool: "llm", args: { prompt: "CALL-ONE: say ok." }, out: "Llm", as: "c0", deadline_s: 120 },
};
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

/** The origin: each request is counted and held until `release()`, then answers 10 output tokens. `reached` resolves when
 *  the first request arrives. */
function heldOrigin() {
  const origin = { sent: 0 };
  let arrived;
  origin.reached = new Promise((resolve) => (arrived = resolve));
  let release;
  const released = new Promise((resolve) => (release = resolve));
  origin.release = release;
  origin.fetch = async (_url, init = {}) => {
    origin.sent += 1;
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
  return origin;
}

/** A claim's workflow spec with its booking wired, as the workflow loop wires it: the spec built for the claim, its hooks
 *  handed over (build), a Harness over the claim's journal on the spec's models with the host's extensions, then
 *  harnessReady, where the booking is made and an earlier claim's requests are booked (bookCut). */
async function claimReady(closing, store, claim, providerOf) {
  const spec = await workflowSpecOf({ store, providerOf })(claim, { journal: () => store.journal(claim) });
  closing.push(() => spec.release());
  const parks = [];
  const { extensions } = spec.build({ park: (refusal) => void parks.push(refusal), paused: () => false, pause: () => {} });
  const registry = createRegistry();
  for (const extension of extensions) registry.install(extension);
  const harness = await Harness.open(store.journal(claim), { models: spec.models, registry, onReport: () => {} }, ctx);
  closing.push(() => harness.close(ctx).catch(() => undefined));
  await spec.harnessReady(harness, ctx);
  return { spec, harness, parks };
}

test("a workflow's model request that answers after its claim lapsed is booked at what it reported by the same runner's next claim", async (t) => {
  // The claims' Harnesses and proxies close before the store does (after hooks run first in, first out), newest first.
  // A request still held at the origin (a failed assertion before its release) is let go first.
  const origin = heldOrigin();
  const closing = [];
  t.after(async () => {
    origin.release();
    for (const close of closing.reverse()) await close();
  });
  const { store, clock } = await storeOn(t);
  await store.agents.create({ id: "agent-1", name: "Calls" }, { id: "rev-1", kind: "workflow", body: { workflow: oneCall, tools: ["llm"] } });
  await store.runs.create({ id: "run-1", agentId: "agent-1", revisionId: "rev-1" }, { body: { input: {}, title: "t", place: { mode: "runner" }, max_cost_usd: 100 } });
  const providerOf = () => ({ modelId: PRICED.id, api: "anthropic-messages", origin: "https://faux.invalid", credential: () => `not-a-secret-${"w"}`, policy: anthropicPolicy({ model: PRICED.id, tools: [] }), price: (_m, u) => ((u.output ?? 0) * 100) / 1e6, capModel: PRICED, fetch: origin.fetch });

  // The first claim sends the workflow's model request through its own proxy; the origin holds it.
  const first = await store.claim("run-1", "runner-a", { leaseMs: LEASE_MS });
  assert.equal(first?.epoch, 1, "the run is claimed");
  const lost = await claimReady(closing, store, first, providerOf);
  const model = lost.spec.models.getModels().find((m) => m.id === PRICED.id);
  assert.ok(model, "the claim's models carry the priced model at its proxy");
  const answer = lost.spec.models.completeSimple(model, { messages: [{ role: "user", content: "CALL-ONE: say ok.", timestamp: T0 }] }, {}).catch((error) => ({ stopReason: "error", errorMessage: String(error) }));
  // A request that ends before it reaches the origin fails here with its result, instead of waiting on `reached` forever.
  const early = await Promise.race([origin.reached.then(() => undefined), answer]);
  assert.equal(early, undefined, `the request reaches the origin before it ends: ${JSON.stringify(early)}`);

  // The first claim lapses on the store's clock while its request is out; the same runner takes the run at the next epoch.
  clock.now = T0 + LEASE_MS + 1;
  const again = await store.claim("run-1", "runner-a", { leaseMs: LEASE_MS });
  assert.equal(again?.epoch, 2, "the run is taken again by the same runner");

  // The request answers now: the lost claim's write of its cost is refused, the run's claim having moved on.
  origin.release();
  await answer;

  // The next claim's harnessReady books what the lost claim's booking saw answer (bookCut), before the workflow resumes.
  const taken = await claimReady(closing, store, again, providerOf);
  assert.deepEqual(taken.parks, [], "the run is not parked");
  assert.equal(origin.sent, 1, "the request was sent once");

  // The run's cost, as its end writes it (endPatch: the booking's spend), is what the request reported, never its hold.
  const { costUsd } = await taken.spec.endPatch();
  assert.equal(eight(costUsd ?? -1), eight(REPORTED_USD), `the run's cost is the request's reported cost, never its hold (${REQUEST_HOLD}): ${costUsd}`);

  // Its record on the run's model session, booked once, at what it reported, never cut.
  const records = await journalSessions(taken.harness, ctx, { flush: () => store.flush() }).read(WORKFLOW_SESSION);
  assert.ok(records.some((r) => r.kind === RUNNER_RECORDS.request && r.data?.model === PRICED.id), `the request was admitted on the run's model session: ${JSON.stringify(records)}`);
  const turns = records.filter((r) => r.kind === RUNNER_RECORDS.turn).map((r) => r.data);
  assert.equal(turns.length, 1, `booked once: ${JSON.stringify(turns)}`);
  assert.equal(turns[0].cut, undefined, `never cut: ${JSON.stringify(turns[0])}`);
  assert.equal(eight(turns[0].usd), eight(REPORTED_USD), `at what it reported: ${JSON.stringify(turns[0])}`);
  const read = sessionSpendOf(records);
  assert.ok(eight(read.cost.usd ?? -1) === eight(REPORTED_USD) && read.cost.unpriced === 0, `the run's cost is known and metered: ${JSON.stringify(read.cost)}`);
});
