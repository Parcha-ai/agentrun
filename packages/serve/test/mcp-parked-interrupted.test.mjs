// A CLI's parked MCP call that was approved and then cut by a crash (its record holds a start and an end "interrupted",
// with no output) is answered on resume in the kernel's words for a call whose outcome is not known
// (INTERRUPTED_TEXT: it may or may not have taken effect), never as if it plainly ended, and it is never run again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { INTERRUPTED_TEXT } from "@parcha/agentrun-kernel/kernel";
import { parkedFollowUp } from "../dist/runner/mcp-run.js";
import { KINDS } from "../dist/runner/journal-kinds.js";

test("an approved parked call a crash cut is answered in the words of an outcome not known, and never run again", async () => {
  let ran = false;
  const entries = [
    { kind: KINDS.ask, data: { callId: "call-1", tool: "mcp:srv/write", args: {}, price: "not metered" } },
    { kind: KINDS.answer, data: { callId: "call-1", approved: true, decision: "allow" } },
    { kind: KINDS.callStart, data: { callId: "call-1", tool: "mcp__srv__write", input: {}, replaySafe: false } },
    { kind: KINDS.callEnd, data: { callId: "call-1", status: "interrupted" } },
  ];
  const result = await parkedFollowUp({ priceOf: () => 0 }, {
    entries,
    answer: async () => ({ callId: "call-1", approved: true }),
    deniedNow: async () => undefined,
    run: async () => { ran = true; return { text: "ran again", isError: false }; },
  });
  assert.equal(ran, false, "never run again");
  assert.ok(result && result.callIds.includes("call-1"), "the call is answered");
  assert.ok(result.text.includes(INTERRUPTED_TEXT), `the kernel's words for an outcome not known: ${result.text}`);
  assert.ok(!result.text.includes("call ended interrupted."), result.text);
});
