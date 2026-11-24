// A run's computer as the run read shows it (run-computer.ts): the run's `computer` field from the run's own state, with
// a computer that could not be had as failed and why, and taken_over read through the ComputerStateOf port (a stand-in
// for the store-backed take-over's state here).
import assert from "node:assert/strict";
import { test } from "node:test";
import { runComputerField } from "../dist/run-computer.js";

const PHONE = { kind: "phone", provider: "phone-harness" };

/** A stand-in for computerStateOf: the runs in `held` are taken over. */
const stateOf = (held) => (runId, state) => (held.has(runId) ? "taken_over" : state);

test("the run's computer field: none for no computer; the run's own state; taken_over from the port; failed with why", () => {
  assert.equal(runComputerField({ kind: "none" }, { id: "r1", status: "running" }), undefined);
  assert.deepEqual(runComputerField(PHONE, { id: "r1", status: "queued" }), { kind: "phone", provider: "phone-harness", state: "starting" });
  assert.deepEqual(runComputerField(PHONE, { id: "r1", status: "running" }), { kind: "phone", provider: "phone-harness", state: "ready" });
  assert.deepEqual(runComputerField(PHONE, { id: "r1", status: "running" }, stateOf(new Set(["r1"]))), { kind: "phone", provider: "phone-harness", state: "taken_over" });
  assert.deepEqual(runComputerField(PHONE, { id: "r2", status: "running" }, stateOf(new Set(["r1"]))), { kind: "phone", provider: "phone-harness", state: "ready" }, "another run's hold is not this one's");
  assert.deepEqual(runComputerField(PHONE, { id: "r1", status: "completed" }, stateOf(new Set(["r1"]))), { kind: "phone", provider: "phone-harness", state: "ended" }, "an ended run's computer is ended, whatever the register says");
  const why = "Phone harness needs PHONE_HARNESS_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/phone-harness/keys)";
  assert.deepEqual(runComputerField(PHONE, { id: "r1", status: "failed", error: { code: "computer_unavailable", message: why } }), { kind: "phone", provider: "phone-harness", state: "failed", why });
});

test("a stopped run's computer reads released, and a parked run's once its claim let it go, ready while it is kept for the resume", async () => {
  const { runComputerRead } = await import("../dist/computer-held-routes.js");
  const { keptKeyOf } = await import("../dist/workspace/computer-kept.js");
  const NOW = Date.parse("2026-11-24T12:00:00Z");
  const kept = new Map();
  /** A store with one run, `state` as its row says, whose agent has a desktop; `kept` its settings' kept rows. */
  const store = (state) => ({
    runs: { get: async () => ({ id: "r1", revisionId: "rev-1", state }), launch: async () => ({ body: {} }) },
    agents: { revision: async () => ({ body: { computer: { kind: "desktop", provider: "faux-desktop" } } }) },
    settings: { get: async (key) => kept.get(key) },
  });
  const stateOf = async (row, status) => (await runComputerRead(store(row), "r1", { status }, { now: () => NOW, entries: async () => [] })).computer?.state;
  assert.equal(await stateOf("parked", "input_required"), "released", "stopped or asking with no keep: its desktop is gone");
  kept.set(keptKeyOf("r1"), { provider: "faux-desktop", kind: "desktop", id: "d1", name: "d1", epoch: 1, until: NOW + 60_000 });
  assert.equal(await stateOf("parked", "input_required"), "ready", "kept for the resume: an answer goes on on the same one");
  kept.set(keptKeyOf("r1"), { provider: "faux-desktop", kind: "desktop", id: "d1", name: "d1", epoch: 1, until: NOW - 1 });
  assert.equal(await stateOf("parked", "input_required"), "released", "its keep's time passed");
  assert.equal(await stateOf("stopped", "input_required"), "released", "a stop lets it go, though the run takes a follow-up");
  assert.equal(await stateOf("running", "working"), "ready");
});
