// A parked MCP call (a harness with its own client, its call parked through the door) whose gate answers deny
// asynchronously is denied in words and never run. The gate is Promise-capable on purpose (run-cap's and the approvals'
// gates may look a decision up), so the follow-up awaits the gate's answer: a deny that resolves to a string denies the
// call, never a pending Promise used as the answer (which would mislabel the result and could let the call run on an allow).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parkedFollowUp } from "../dist/runner/mcp-run.js";
import { KINDS } from "../dist/runner/journal-kinds.js";

test("a parked call whose gate denies asynchronously gets the deny words and never runs", async () => {
  let ran = false;
  const mcp = { priceOf: () => 0 };
  const entries = [{ kind: KINDS.ask, data: { callId: "call-1", tool: "mcp__srv__wire", args: {}, price: 0 } }];
  const result = await parkedFollowUp(mcp, {
    entries,
    // The approve/deny row handed the claim said allow; the gate's own word now (a deny set since) is what denies it.
    answer: async () => ({ callId: "call-1", approved: true }),
    // The gate answers deny asynchronously (a decision looked up): the follow-up must await it.
    deniedNow: async () => "Permission denied: mcp__srv__wire is set to deny.",
    run: async () => { ran = true; return { text: "the call ran", isError: false }; },
  });
  assert.equal(ran, false, "a call the gate denies is never run");
  assert.ok(result && result.callIds.includes("call-1"), "the call is answered");
  assert.match(result.text, /set to deny/, "the deny words are in the resume text, not a pending Promise");
});
