// The live translate's words for what a person reads: a result that is only pi's diagnostics block shows its message, a
// tool's own output is never cut down to it, and a person's stop is one row even when the loop's end is the run's first
// record (a stop waiting when the loop could not open).
import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_PHASE } from "@parcha/pi-durable-agent/timeline";
import { KINDS } from "../dist/runner/journal-kinds.js";
import { emptyState, STOPPED_BY_YOU, translate } from "../dist/live/translate.js";

let seq = 0;
const commit = (entries) => ({ seq: ++seq, entries, documents: [], tasks: [], submissions: [] });
const entry = (kind, data, model) => ({ id: ++seq, conversationId: 1, kind, data, ...(model ? { model } : {}) });
const result = (text) => entry("pi.tool-result", {}, [{ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text }], isError: true }]);
/** The text of the result a commit holding `text` streams, after a first commit that starts the run. */
function streamedResult(text) {
  const state = emptyState();
  translate(state, commit([entry(KINDS.message, { role: "person", text: "Run it." })]));
  const events = translate(state, commit([result(text)]));
  const ended = events.find((event) => event.type === "message_end");
  return ended.entry.model[0].content.map((block) => block.text).join("");
}

test("a result that is only pi's diagnostics block shows its message, never the block's markup", () => {
  assert.equal(streamedResult("<harness>\n[error] Tool bash failed: exit 2\n</harness>"), "Tool bash failed: exit 2");
});

test("a tool's own output after a diagnostics block is kept whole: only a result that is nothing but the block is rewritten", () => {
  const text = "<harness>\n[info] a note\n</harness>\nthe tool's own output\nline two";
  assert.equal(streamedResult(text), text);
});

test("a stopped end that is the run's first record still gives the one stop row", () => {
  const state = emptyState();
  const events = translate(state, commit([entry(KINDS.end, { state: "stopped", summary: "stopped by a person" })]));
  const rows = events.filter((event) => event.type === "entry_appended" && event.entry.kind === HOST_PHASE).map((event) => event.entry.data.summary);
  assert.deepEqual(rows, [STOPPED_BY_YOU], JSON.stringify(events));
});
