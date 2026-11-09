// A workflow run's decisions and its model requests draw on one spend, as on main (serve cap.ts holdPaid: a decision is
// held against what the whole run has spent and holds): a decision is judged on the run's model spend beside its own, its
// refusal's figures say the run's spend, and what a decision held and was charged is journaled where the run's model
// requests are, so a claim taken again after a lost one counts the earlier claim's decisions.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNNER_RECORDS } from "@parcha/agentrun-kernel";
import { memorySessionStore } from "@parcha/agentrun-kernel/testing";
import * as cap from "../dist/kernel/cap/index.js";

const T0 = Date.parse("2026-11-09T02:00:00Z");
const MODEL_SESSION = "workflow";
/** A decision model whose hold is its input alone: $1 a million input tokens, its output free. */
const DECIDER = { id: "decider", api: "openrouter", price: { input: 1, output: 0 }, outputCeiling: null };
/** A decision request held at `usd` (its input at $1 a million tokens). */
const decision = (id, usd) => ({ kind: "decision", id, model: DECIDER, inputTokens: Math.round(usd * 1e6), questions: 1 });

/** The run's model spend as its booking keeps it: a model request answered at `usd`. */
async function modelSpent(store, usd) {
  const writer = await store.open(MODEL_SESSION);
  await writer.append([{ kind: RUNNER_RECORDS.request, data: { turn: 1, model: "claude-sonnet-4-5", heldUsd: usd } }, { kind: RUNNER_RECORDS.turn, data: { turn: 1, usd, bookedUsd: usd } }]);
}

/** The run's decisions under a cap of `capUsd`, on this claim, over the run's sessions `store`. */
async function decisionsOf(store, capUsd) {
  const run = cap.runCap({ sessions: store, capUsd: () => capUsd, mode: "expected", now: () => T0, modelOf: () => undefined });
  return run.decisions(await store.open(cap.DECISION_SESSION));
}

test("on the run's one cap a decision is held as main holds it: 256 output tokens a question (expected), its model's most (strict), its fees and images, none with no cap", async () => {
  const MODEL = { id: "openai/gpt-6-sol", api: "openrouter", price: { input: 1.25, output: 10 }, outputCeiling: 4_096 };
  const asked = { kind: "decision", inputTokens: 1_000, questions: 3, images: 2, requestUsd: 0.002, imageUsd: 0.0005 };
  for (const [mode, model] of [["expected", MODEL], ["expected", { ...MODEL, outputCeiling: null }], ["strict", MODEL]]) {
    // The decision cap's own figure (createCap, held to main's holdOf by serve's kernel-cap-decision-parity).
    const alone = await cap.createCap({ capUsd: () => 100, mode, now: () => T0 }).admit({ ...asked, id: "d", model });
    const store = memorySessionStore();
    const decisions = await cap.runCap({ sessions: store, capUsd: () => 100, mode, now: () => T0, modelOf: () => undefined }).decisions(await store.open(cap.DECISION_SESSION));
    const admitted = await decisions.admit({ ...asked, id: "d", model });
    near(admitted.heldUsd, alone.heldUsd, `${mode}, most output ${model.outputCeiling}`);
  }
  const store = memorySessionStore();
  const uncapped = await cap.runCap({ sessions: store, capUsd: () => undefined, modelOf: () => undefined }).decisions(await store.open(cap.DECISION_SESSION));
  const admitted = await uncapped.admit({ ...asked, id: "d", model: "unreadable" });
  assert.equal(admitted.heldUsd, 0, "with no cap nothing is priced, an unreadable price refuses nothing");
});

/** The run's sessions on a machine: an append is committed but survives a lost box only once flushed; `lose()` is the
 *  box lost, every record appended since the last flush gone. */
function machine() {
  const durable = new Map();
  const pending = new Map();
  const add = (into, key, records) => into.set(key, [...(into.get(key) ?? []), ...records]);
  const store = {
    keys: () => [...new Set([...durable.keys(), ...pending.keys()])],
    read: async (key) => structuredClone([...(durable.get(key) ?? []), ...(pending.get(key) ?? [])]),
    open: async (key) => ({
      key,
      read: () => store.read(key),
      append: async (records) => void add(pending, key, records),
      flush: async () => store.flush(),
    }),
    flush: async () => {
      for (const [key, records] of pending) add(durable, key, records);
      pending.clear();
    },
    lose: () => pending.clear(),
  };
  return store;
}

test("a decision sent and its box lost before any later write still counts after the next claim: its hold is flushed before it leaves", async () => {
  const box = machine();
  const first = await cap.runCap({ sessions: box, capUsd: () => 1, mode: "expected", now: () => T0, modelOf: () => undefined }).decisions(await box.open(cap.DECISION_SESSION), { flush: () => box.flush() });
  const admitted = await first.admit(decision("decide-1", 0.25));
  // Its call is sent, and the box is lost before anything else is written.
  box.lose();
  const next = await cap.runCap({ sessions: box, capUsd: () => 1, mode: "expected", now: () => T0, modelOf: () => undefined }).decisions(await box.open(cap.DECISION_SESSION), { flush: () => box.flush() });
  // A decision's input-only price reads no cache, so its bound is 0: it counts at its hold plus that bound.
  near(next.spentUsd(), admitted.heldUsd + admitted.boundUsd, "the lost decision, at its hold and bound");
  near(admitted.heldUsd, 0.25, "its hold");
});

const near = (actual, expected, what) => assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);

test("a decision under a tight cap is judged on the run's model spend beside its own: refused, its figures the run's, as main's", async () => {
  const store = memorySessionStore();
  await modelSpent(store, 0.6);
  const decisions = await decisionsOf(store, 1);
  const refused = await decisions.admit(decision("decide-1", 0.5)).then(() => undefined, (error) => error);
  assert.ok(refused instanceof cap.CapRefused, `refused for room, as main holds it against the run's $0.60: ${refused ?? "it was admitted"}`);
  // main's paidRefusal figures: the run's spend and holds, the decision's hold, and the least cap that sends it.
  near(refused.figures?.spentUsd, 0.6, "spent");
  near(refused.figures?.needsUsd, 0.5, "needs");
  near(refused.figures?.leastCapUsd, cap.raiseFigure(1, 1.1), "least cap");
  assert.equal(refused.forGood, false, "a raise sends it");
});

test("a decision held and settled before a lost claim still counts after the next claim: the run's cap is never passed after a restart", async () => {
  const store = memorySessionStore();
  const first = await decisionsOf(store, 1);
  await first.admit(decision("decide-1", 0.25));
  await first.settle("decide-1", { end: "charged", usd: 0.25 });
  // The claim is lost; the next claim opens the run's decisions again over the same journal.
  const next = await decisionsOf(store, 1);
  near(next.spentUsd(), 0.25, "the next claim's decision spend");
  const refused = await next.admit(decision("decide-2", 0.8)).then(() => undefined, (error) => error);
  assert.ok(refused instanceof cap.CapRefused, `the second decision does not fit beside the first's $0.25: ${refused ?? "it was admitted"}`);
  near(refused.figures?.spentUsd, 0.25, "spent, the earlier claim's decision included");
});
