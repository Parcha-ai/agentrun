// A run's computer as the run read shows it (run-computer.ts): the run's `computer` field from the run's own state, with
// a computer that could not be had as failed and why, and taken_over from the one register of held computers, read
// through the ComputerStateOf port (a stand-in for the computer view's computerStateOf here).
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
