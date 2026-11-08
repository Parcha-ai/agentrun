// A run's computer as the run read shows it (run-computer.ts): the run's `computer` field from its runner's live word when
// it has one, else from the run's own state, with a computer that could not be had as failed and why.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runComputerField } from "../dist/run-computer.js";

const PHONE = { kind: "phone", provider: "phone-harness" };

test("the run's computer field: none for no computer; the runner's word when it has one; else the run's own state says it", () => {
  assert.equal(runComputerField({ kind: "none" }, { status: "running" }), undefined);
  assert.deepEqual(runComputerField(PHONE, { status: "queued" }), { kind: "phone", provider: "phone-harness", state: "starting" });
  assert.deepEqual(runComputerField(PHONE, { status: "running" }), { kind: "phone", provider: "phone-harness", state: "ready" });
  assert.deepEqual(runComputerField(PHONE, { status: "running" }, { state: "taken_over" }), { kind: "phone", provider: "phone-harness", state: "taken_over" });
  assert.deepEqual(runComputerField(PHONE, { status: "running" }, { state: "failed", why: "the phone stopped answering" }), { kind: "phone", provider: "phone-harness", state: "failed", why: "the phone stopped answering" });
  assert.deepEqual(runComputerField(PHONE, { status: "completed" }, { state: "ready" }), { kind: "phone", provider: "phone-harness", state: "ended" }, "an ended run's computer is ended, whatever was last said");
  const why = "Phone harness needs PHONE_HARNESS_API_KEY saved: save it in Settings → Computers (PUT /v2/computers/phone-harness/keys)";
  assert.deepEqual(runComputerField(PHONE, { status: "failed", error: { code: "computer_unavailable", message: why } }), { kind: "phone", provider: "phone-harness", state: "failed", why });
});
