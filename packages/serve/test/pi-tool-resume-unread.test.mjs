// A host tool's call that pi runs again after a crash (its intent saved, so no beforeTool) reads its turn back in its
// execute (piTool's restoreOf). A first run never fails that read there: beforeTool read the turn first, or blocked the
// call. So a read that fails in execute is a resumed call's, and an earlier attempt of it may have taken effect (a
// nesting tool's nested calls, a tool that wrote before the crash). Its words must say so, never that nothing was done.
// piTool's execute is called as pi's tool task calls it. Pure: no pi loop, no model, no network.
import assert from "node:assert/strict";
import { test } from "node:test";

const { piTool } = await import("../dist/runner/adapters/pi.js");

test("piTool, a resumed call whose turn cannot be read back: it never runs again, and its words say an earlier attempt may have taken effect", async () => {
  let ran = 0;
  const tool = { name: "send_note", description: "Sends a note.", inputSchema: { type: "object", properties: {} }, replay: "safe", nests: true, call: async () => { ran += 1; return { text: "sent" }; } };
  const io = { onEvent() {}, signal: new AbortController().signal };
  // The adapter's restoreOf rejects in its own plain words, the store's error as its cause.
  const restoreOf = () => Promise.reject(new Error("This call did not run: its turn could not be read back from its conversation, so what the turn has left for its result is unknown. Nothing it would do was done; it may be called again.", { cause: new Error("store: SQLITE_BUSY reading entries") }));
  // The claim's budget is made before the read (as the adapter's turnOf makes one on first use); the read fails first.
  const turnOf = () => ({});
  const piCall = piTool(tool, io, undefined, undefined, undefined, () => undefined, turnOf, restoreOf);
  const api = {
    callId: "call-1",
    conversationId: "conv-1",
    agent: async () => ({ model: { provider: "faux", modelId: "faux-1" } }),
    models: { getModel: () => undefined },
    output() {},
  };
  const error = await piCall.execute({}, api, {}).then(() => undefined, (thrown) => thrown);
  assert.ok(error instanceof Error, "the resumed call fails");
  assert.equal(ran, 0, "the tool does not run again on a turn it could not read");
  assert.match(error.message, /earlier attempt/, `the words say an earlier attempt may have acted: ${error.message}`);
  assert.doesNotMatch(error.message, /Nothing it would do was done/, "never that nothing was done");
  assert.doesNotMatch(error.message, /SQLITE_BUSY|store:/, "the store's own words stay off the model's transcript");
  assert.ok(error.message.length <= 400, `whole within RESULT_ALWAYS_WHOLE_CHARS: ${error.message.length}`);
});
