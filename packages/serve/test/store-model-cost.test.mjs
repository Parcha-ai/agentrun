// A CLI harness's run (codex, opencode, claude-agent) books its model requests in the runner's session records
// (runner.request / runner.turn, in a conversation of their own), not on the root as a pi run does. Its /usage meters and
// its cap read that booking (metrics.ts bookedSpend, bookedCapSpend): its tokens meter is its model requests' booked cost,
// unknown, never $0, when one priced none; its spent figure the cap's reading of the same records. The design and the
// fixture are tl-untangle's (its CLI model-cost fold); the reader is main's one booked reader.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import { storeOn, T0 } from "./store-helpers.mjs";

const { metersOverStore, spentOverStore } = await import("../dist/store-reads/cap.js");

const context = BACKGROUND_CONTEXT;
const ROOT = 1;

async function claimed(store, { harness = "codex", runId = "run-1" } = {}) {
  if (!(await store.agents.get("agent-1"))) await store.agents.create({ id: "agent-1", name: "A" }, { id: "rev-1", kind: "agentic", body: { instructions: "x", harness } });
  await store.runs.create({ id: runId, agentId: "agent-1", revisionId: "rev-1" }, { body: { input: { message: "Hi" }, title: "t", place: { mode: "runner" } } });
  return store.claim(runId, "runner-a", { leaseMs: 60_000 });
}

/** A CLI run `runId` whose model requests booked `usds` in a session conversation of their own, ended. */
async function cliRun(store, runId, usds) {
  const claim = await claimed(store, { harness: "codex", runId });
  const j = store.journal(claim);
  const conv = await j.mintId();
  const writes = [
    { type: "conversation", value: { id: ROOT } },
    { type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "agentrun.message", data: { role: "person", text: "go" } } },
    { type: "conversation", value: { id: conv } },
  ];
  for (const [i, usd] of usds.entries()) {
    writes.push({ type: "entry", value: { id: await j.mintId(), conversationId: conv, kind: "runner.request", data: { turn: i + 1, model: "agent-model/house-x" } } });
    writes.push({ type: "entry", value: { id: await j.mintId(), conversationId: conv, kind: "runner.turn", data: { turn: i + 1, usd } } });
  }
  writes.push({ type: "entry", value: { id: await j.mintId(), conversationId: ROOT, kind: "agentrun.message", data: { role: "model", text: "done" } } });
  await commitWrites(j, writes, context);
  await store.runs.update(claim, { state: "ended", outcome: "completed", summary: "done", endedAt: T0 + 9 });
}

test("metersOverStore's tokens meter and spentOverStore (the cap) carry a CLI run's model cost over the store", async (t) => {
  const { store } = await storeOn(t);
  await cliRun(store, "cli", [0.03]);
  const m = await metersOverStore(store, "cli", context);
  // The tokens meter is the model spend, never under tools or browser.
  assert.equal(m.tokens, 0.03);
  assert.equal(m.known.tokens, 0.03);
  assert.equal(m.tools, 0);
  assert.deepEqual(m.browser, { usd: 0, seconds: 0 });
  // The cap reads the same model spend.
  assert.equal(await spentOverStore(store, "cli", context), 0.03);
});

test("a CLI run's model request with no price makes its tokens meter unknown, its known part kept, never $0", async (t) => {
  const { store } = await storeOn(t);
  await cliRun(store, "cli", [0.03, null]);
  const m = await metersOverStore(store, "cli", context);
  assert.equal(m.tokens, null, `unknown, never $0: ${JSON.stringify(m)}`);
  assert.equal(m.known.tokens, 0.03, "the known part kept");
});
