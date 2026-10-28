// A stopped run stays stopped until the person sends another message, whatever happens to the messages it shows: the
// stop is kept as the stopped message's id, so a compaction (fewer messages shown) or a rewrite of the list never moves
// it in either direction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stopMark, stoppedAt } from "../dist/runs.js";

const user = (id) => ({ id, kind: "user_message", summary: `You: ${id}` });
const answer = (id) => ({ id, kind: "final_answer", summary: "Done." });

test("a run stopped and then compacted (its older messages no longer shown) still reads stopped at the same message", () => {
  const before = [user("0:1"), answer("0:2"), user("0:5"), answer("0:6"), user("0:9")];
  const meta = stopMark(before);
  assert.equal(stoppedAt(meta, before), true);
  // The compaction summarized the first two exchanges: one message shown where there were three.
  const compacted = [{ id: "0:12", kind: "phase", summary: "Summarized older context" }, user("0:9")];
  assert.equal(stoppedAt(meta, compacted), true, "still stopped at 0:9");
});

test("a run stopped, sent a new message, and then compacted to as many messages as it had at the stop does not read stopped", () => {
  const atStop = [user("0:1"), answer("0:2"), user("0:5")];
  const meta = stopMark(atStop);
  // A new message, then a compaction leaves two messages shown: the count at the stop, but not the stopped message.
  const after = [user("0:5"), answer("0:6"), user("0:9")].slice(0);
  const compacted = [{ id: "0:12", kind: "phase", summary: "Summarized older context" }, user("0:8"), user("0:9")];
  assert.equal(atStop.filter((r) => r.kind === "user_message").length, compacted.filter((r) => r.kind === "user_message").length, "the same count");
  assert.equal(stoppedAt(meta, after), false, "a message since the stop");
  assert.equal(stoppedAt(meta, compacted), false, "a message since the stop, at the stop's count");
});

test("a run stopped by an older server, with only the count kept, reads as it did", () => {
  const rows = [user("0:1"), answer("0:2"), user("0:5")];
  assert.equal(stoppedAt({ stopped_after: 2 }, rows), true);
  assert.equal(stoppedAt({ stopped_after: 1 }, rows), false);
  assert.equal(stoppedAt({}, rows), false, "never stopped");
});
