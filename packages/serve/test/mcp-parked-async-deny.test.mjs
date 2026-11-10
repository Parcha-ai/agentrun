// A parked MCP call (a harness with its own client, its call parked through the door) whose gate answers deny
// asynchronously is denied in words and never run. The gate is Promise-capable on purpose (run-cap's and the approvals'
// gates may look a decision up), so the follow-up awaits the gate's answer: a deny that resolves to a string denies the
// call, never a pending Promise used as the answer (which would mislabel the result and could let the call run on an allow).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parkedFollowUp } from "../dist/runner/mcp-run.js";
import { KINDS } from "../dist/runner/journal-kinds.js";

/** The follow-up of one parked call the person allowed, its gate's word now answered asynchronously as `now`. */
async function followUp(now) {
  const ran = [];
  const mcp = { priceOf: () => 0 };
  const entries = [{ kind: KINDS.ask, data: { callId: "call-1", tool: "mcp__srv__wire", args: {}, price: 0 } }];
  const result = await parkedFollowUp(mcp, {
    entries,
    // The approve/deny row handed the claim said allow; the gate's own word now (a deny set since) is what denies it.
    answer: async () => ({ callId: "call-1", approved: true }),
    // The gate answers asynchronously (a decision looked up): the follow-up must await it.
    deniedNow: async () => now,
    run: async (call) => (ran.push(call.callId), { text: "the call ran", isError: false }),
  });
  return { ran, result };
}

test("a parked call whose gate denies asynchronously gets the deny words and never runs", async () => {
  const { ran, result } = await followUp("Permission denied: mcp__srv__wire is set to deny.");
  assert.deepEqual(ran, [], "a call the gate denies is never run");
  assert.ok(result && result.callIds.includes("call-1"), "the call is answered");
  assert.match(result.text, /set to deny/, "the deny words are in the resume text, not a pending Promise");
});

test("a parked call whose gate's asynchronous word is no deny (undefined) runs once, its answer in the resume text", async () => {
  // A pending Promise taken as the answer is never undefined: an unawaited gate would refuse this call.
  const { ran, result } = await followUp(undefined);
  assert.deepEqual(ran, ["call-1"], "the allowed call runs exactly once");
  assert.ok(result && result.callIds.includes("call-1"), "the call is answered");
  assert.match(result.text, /the call ran/);
  assert.doesNotMatch(result.text, /\[object Promise\]/);
});
