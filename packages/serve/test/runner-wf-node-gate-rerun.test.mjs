// A workflow model node's tool call that the gate let through, cut with its claim (the runner went, the lease lapsed) and
// run again by pi-durable's recovery on the next claim, now with its tool set to deny: the model must read that whether the
// call took effect is not known (RAN_UNKNOWN), never that nothing was sent and nothing was charged (NOT_RUN), which would
// be false of a call that may have reached its host. The gate keeps that it let a call through in the call's own task
// (its memo, committed with the task), so the rerun on the next claim reads it. A call it never let through is refused in
// the plain words. (Ported from tool-gate-replayed-relaunch.test.mjs, which drove a per-run process's death and relaunch;
// the gate's rule is the same on the runner.)
import assert from "node:assert/strict";
import { test } from "node:test";

const { gatedNodeCall } = await import("../dist/runner/workflow-spec.js");
const { NOT_RUN, RAN_UNKNOWN } = await import("../dist/refusal-words.js");

/** A task's api as pi-durable gives a tool call: its memos kept across attempts of the same task (a rerun on the next
 *  claim reads what the first attempt wrote), and nothing else this gate reads. */
function taskApi() {
  const memos = new Map();
  return {
    callId: "call_1",
    memo: async (name, ...rest) => {
      if (rest.length < 2) return memos.get(name);
      if (!memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
  };
}
const textOf = (result) => JSON.stringify(result);

test("a model node's call let through, then run again after its claim was cut with the tool now denied, reads RAN_UNKNOWN, never NOT_RUN", async () => {
  let permission = "allow";
  const policy = async () => ({ permission, denyFrom: "server" });
  let ran = 0;
  const call = gatedNodeCall("web_fetch", policy, async () => ((ran += 1), { output: "the page" }));
  const api = taskApi();
  // The first attempt: let through and sent (its answer then lost with the claim).
  assert.deepEqual(await call({ url: "https://example.com" }, api, {}), { output: "the page" });
  // The next claim: the same task run again by recovery, its tool now set to deny.
  permission = "deny";
  const rerun = textOf(await call({ url: "https://example.com" }, api, {}));
  assert.ok(rerun.includes(RAN_UNKNOWN), `the rerun says whether it took effect is not known: ${rerun}`);
  assert.ok(!rerun.includes(NOT_RUN), "never that nothing was sent and nothing was charged");
  assert.equal(ran, 1, "the denied rerun runs nothing");
});

test("a model node's call the gate never let through, denied, reads NOT_RUN: nothing was sent", async () => {
  const policy = async () => ({ permission: "deny", denyFrom: "server" });
  const call = gatedNodeCall("web_fetch", policy, async () => assert.fail("a denied call never runs"));
  const refused = textOf(await call({ url: "https://example.com" }, taskApi(), {}));
  assert.ok(refused.includes(NOT_RUN), refused);
});
