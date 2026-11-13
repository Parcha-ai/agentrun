// OpenCode's transcript rewrite for a resumed run (src/harness-opencode/transcript.ts): the session's mirrored sync events
// (what /sync/replay gives back to OpenCode) read for the calls OpenCode started and never ended, and one such call given
// its outcome, as OpenCode itself records a call's end: the tool part's state completed with its output (or an error with
// its words), then its message completed, each a new event after the last, nothing before it changed. The shared resume
// decision runs (or refuses) the call through the bridge first; this only writes what the bridge answered.
import assert from "node:assert/strict";
import { test } from "node:test";
import { danglingCalls, settleCall } from "../dist/harness-opencode/transcript.js";

const SID = "ses_0001";
const created = { id: "evt_a", aggregate_id: SID, seq: 0, type: "session.created.1", data: { sessionID: SID, info: { id: SID, title: "AgentRun session" } } };
const user = { id: "evt_b", aggregate_id: SID, seq: 1, type: "message.updated.1", data: { sessionID: SID, info: { id: "msg_u", sessionID: SID, role: "user", time: { created: 1 } } } };
const assistantInfo = { id: "msg_a", sessionID: SID, role: "assistant", parentID: "msg_u", time: { created: 2 }, modelID: "model", providerID: "openai", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
const assistant = { id: "evt_c", aggregate_id: SID, seq: 2, type: "message.updated.1", data: { sessionID: SID, info: assistantInfo } };
const toolPart = (callID, state) => ({ id: `prt_${callID}`, sessionID: SID, messageID: "msg_a", type: "tool", callID, tool: "hands_effect", state });
const running = { id: "evt_d", aggregate_id: SID, seq: 3, type: "message.part.updated.1", data: { sessionID: SID, part: toolPart("call_1", { status: "running", input: { n: 1 }, time: { start: 10 } }), time: 10 } };
const EVENTS = Object.freeze([created, user, assistant, running]);

test("a call OpenCode started and never ended is dangling: its id, the host's tool name and its arguments", () => {
  assert.deepEqual(danglingCalls(EVENTS), [{ callId: "call_1", tool: "effect", args: { n: 1 } }]);
  const done = { ...running, id: "evt_e", seq: 4, data: { ...running.data, part: toolPart("call_1", { status: "completed", input: { n: 1 }, output: "ok", title: "", metadata: {}, time: { start: 10, end: 11 } }) } };
  assert.deepEqual(danglingCalls([...EVENTS, done]), [], "a call with its end is not dangling");
});

test("settled with its outcome: the part completed with its output, then its message completed, as new events after the last", () => {
  const settled = settleCall(EVENTS, "call_1", { text: "ran once", isError: false }, 50);
  assert.deepEqual(settled.slice(0, 4), [...EVENTS], "nothing before is changed");
  assert.equal(settled.length, 6);
  const [part, message] = settled.slice(4);
  assert.deepEqual([part.aggregate_id, part.seq, part.type, message.seq, message.type], [SID, 4, "message.part.updated.1", 5, "message.updated.1"]);
  assert.match(part.id, /^evt_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.notEqual(part.id, message.id);
  assert.deepEqual(part.data.part.state, { status: "completed", input: { n: 1 }, output: "ran once", title: "", metadata: {}, time: { start: 10, end: 50 } });
  assert.deepEqual(message.data.info, { ...assistantInfo, time: { created: 2, completed: 50 }, finish: "tool-calls" });
  assert.deepEqual(danglingCalls(settled), [], "nothing dangles after it");
  assert.deepEqual(EVENTS[3].data.part.state.status, "running", "the events given are not touched");
});

test("a failed or interrupted outcome is an error part with its words", () => {
  const settled = settleCall(EVENTS, "call_1", { text: "the call may or may not have taken effect", isError: true }, 60);
  assert.deepEqual(settled[4].data.part.state, { status: "error", input: { n: 1 }, error: "the call may or may not have taken effect", time: { start: 10, end: 60 } });
});

test("a call that is not dangling is refused in words, never rewritten", () => {
  assert.throws(() => settleCall(EVENTS, "call_9", { text: "x", isError: false }), /OpenCode's transcript has no call call_9 that it started and never ended/);
});
