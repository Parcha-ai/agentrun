// ranCalls (runner/journal-kinds.ts), what a tool's own ask counts (tools.ts AskContext.ran): the calls of a tool that ran
// to a good end, read from a run's journal, a CLI's records (agentrun.call.start and its end) and pi's (pi.tool-result)
// together, each call id once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { KINDS, ranCalls } from "../dist/runner/journal-kinds.js";

const start = (callId, tool = "email_send") => ({ kind: KINDS.callStart, data: { callId, tool, input: {}, replaySafe: false } });
const end = (callId, status = "done") => ({ kind: KINDS.callEnd, data: { callId, status, output: "" } });
const piResult = (toolCallId, toolName = "email_send", isError = false) => ({ kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId, toolName, content: [], ...(isError ? { isError: true } : {}) }] });

test("a mixed journal: each call that ran to a good end counts once, whichever record says it, and nothing else does", () => {
  const entries = [
    start("c1"), end("c1"), // a CLI's call, done: 1
    start("c2"), end("c2", "refused"), // refused at its gate
    start("c3"), end("c3", "failed"), // failed
    start("c4"), // never ended
    start("c5", "email_read"), end("c5"), // another tool
    end("c6"), // an end with no start of this tool
    piResult("p1"), // pi's, ok: 2
    piResult("p2", "email_send", true), // pi's, an error (a deny or a refusal)
    piResult("p3", "email_read"), // another tool
    start("both"), end("both"), piResult("both"), // one call both records say: 3, once
    piResult("p1"), // pi's same result read again
  ];
  assert.equal(ranCalls(entries, "email_send"), 3);
  assert.equal(ranCalls(entries, "email_read"), 2);
  assert.equal(ranCalls([], "email_send"), 0);
});
