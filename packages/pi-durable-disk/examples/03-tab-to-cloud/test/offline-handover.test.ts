// Asking for the handover when the answer may be lost: a network error is asked again (the pipe answers a retry of the handover it made as the first time), an answer from the
// pipe ends the asking whatever it says, and an answer that never comes is "unknown", never a guess.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckoutError, confirmHandover } from "../tab/offline.ts";

const fast = { delayMs: 0, sleep: async () => undefined };

test("a lost answer is asked again, and the retry's answer is the outcome", async () => {
  let calls = 0;
  const outcome = await confirmHandover(async () => { if (++calls < 3) throw new TypeError("Failed to fetch"); return 7; }, fast);
  assert.deepEqual(outcome, { state: "done", head: 7 });
  assert.equal(calls, 3);
});

test("an answer from the pipe ends the asking, a refusal included: nothing is asked twice after the pipe spoke", async () => {
  let calls = 0;
  const outcome = await confirmHandover(async () => { calls++; throw new CheckoutError("HEAD_MISMATCH", "copy it again", 9); }, fast);
  assert.equal(outcome.state, "refused");
  assert.equal((outcome as { error: CheckoutError }).error.code, "HEAD_MISMATCH");
  assert.equal(calls, 1);
});

test("an answer that never comes is unknown after the tries, and the tab does not go back to being the writer", async () => {
  let calls = 0;
  const outcome = await confirmHandover(async () => { calls++; throw new TypeError("Failed to fetch"); }, { ...fast, tries: 4 });
  assert.equal(outcome.state, "unknown");
  assert.equal(calls, 4);
});
