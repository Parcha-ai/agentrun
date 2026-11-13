// A pi 1.5 run's journal records, cut down from a real run's dump (claude-sdk's taps/b2/pi-journal-dump.mjs): a message,
// one assistant turn that calls `effect` (replay-unsafe) and `reader` (replay-safe), a steer placed mid-run by the running
// generation, a crash with recovery (effect interrupted, reader rerun), and the answer. `running` is the same run before
// the crash, both tools still executing.
const CALL_EFFECT = "tool:1794121725104:nnrff5mc1nr";
const CALL_READER = "tool:1794121725104:fcldw080qd";

const conversation = { id: 1 };
const user = { id: 7, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "do the two things", timestamp: 1 }] };
const assistant = {
  id: 11,
  conversationId: 1,
  kind: "pi.assistant",
  byTaskId: 9,
  model: [{ role: "assistant", content: [{ type: "toolCall", id: CALL_EFFECT, name: "effect", arguments: { path: "pay.txt" } }, { type: "toolCall", id: CALL_READER, name: "reader", arguments: { path: "notes.txt" } }] }],
};
const generation = (id, status) => ({ id, conversationId: 1, kind: "pi.generation", version: 2, input: {}, background: false, abortRequested: false, state: status, startedAt: 2 });
const tool = (id, callId, state) => ({ id, conversationId: 1, kind: "pi.tool", version: 3, input: { kind: "model", assistant: 11, callId }, owner: 9, background: false, abortRequested: false, state, startedAt: 3 });

export const running = {
  tasks: [
    generation(9, { status: "waiting", checkpoint: { phase: "tools", assistant: 11, tools: [12, 13], pending: [] }, on: [12, 13], policy: "allSettled" }),
    tool(12, CALL_EFFECT, { status: "running", checkpoint: { phase: "execute", arguments: { path: "pay.txt" }, replay: "unsafe" } }),
    tool(13, CALL_READER, { status: "running", checkpoint: { phase: "execute", arguments: { path: "notes.txt" }, replay: "safe" } }),
  ],
  entries: [user, assistant],
};

export const recovered = {
  tasks: [
    generation(9, { status: "terminal", outcome: { status: "completed", result: { entryId: 11 } } }),
    tool(12, CALL_EFFECT, { status: "terminal", outcome: { status: "failed", error: { message: "Tool effect was interrupted and may have partially run" }, result: { kind: "model", entryId: 15 } } }),
    tool(13, CALL_READER, { status: "terminal", outcome: { status: "completed", result: { kind: "model", entryId: 16 } } }),
    generation(24, { status: "terminal", outcome: { status: "completed", result: { entryId: 25 } } }),
  ],
  entries: [
    user,
    assistant,
    {
      id: 15, conversationId: 1, kind: "pi.tool-result", byTaskId: 12,
      model: [{ role: "toolResult", toolCallId: CALL_EFFECT, toolName: "effect", content: [{ type: "text", text: "interrupted" }], isError: true, timestamp: 4 }],
      data: { diagnostics: [{ severity: "error", code: "interrupted", message: "Tool effect was interrupted and may have partially run" }] },
    },
    { id: 16, conversationId: 1, kind: "pi.tool-result", byTaskId: 13, model: [{ role: "toolResult", toolCallId: CALL_READER, toolName: "reader", content: [{ type: "text", text: "reader done" }], isError: false, timestamp: 5 }] },
    // The steer: a person's message the running generation placed mid-run (its byTaskId).
    { id: 17, conversationId: 1, kind: "pi.user", byTaskId: 9, model: [{ role: "user", content: "steer: use notes2.txt", timestamp: 6 }] },
    { id: 25, conversationId: 1, kind: "pi.assistant", byTaskId: 24, model: [{ role: "assistant", content: [{ type: "text", text: "answer; last user said: steer: use notes2.txt" }] }] },
  ],
};

export const piConversation = conversation;
export const piCalls = { effect: CALL_EFFECT, reader: CALL_READER };
