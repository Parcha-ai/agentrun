// A stopped run stays stopped until the person sends another message, whatever happens to the messages it shows: the
// stop is kept as the stopped message's place in the store, and the run reads stopped while no message shown is newer,
// so a compaction (fewer messages shown, the stopped one among them or not) never moves it in either direction.
import assert from "node:assert/strict";
import { test } from "node:test";
import { statusOf, stopMark, stoppedAt } from "../dist/runs.js";

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

test("a compaction that takes the stopped message itself off the rows leaves the run stopped while nothing newer is shown", () => {
  const atStop = [user("1:3"), answer("1:4"), user("1:9")];
  const meta = stopMark(atStop);
  // The cut fell inside the stopped turn: its message is summarized, only the older one and the turn's tail are shown.
  const compacted = [user("1:3"), { id: "1:14", kind: "phase", summary: "Summarized older context" }, answer("1:12")];
  assert.equal(stoppedAt(meta, compacted), true, "the stopped message is gone and nothing newer is shown");
  assert.equal(stoppedAt(meta, [{ id: "1:14", kind: "phase", summary: "Summarized older context" }]), true, "no message shown at all");
  assert.equal(stoppedAt(meta, [...compacted, user("1:16")]), false, "a message since the stop");
});

test("a stop before any message of the person's is kept, and reads stopped", () => {
  const meta = stopMark([]);
  assert.equal(typeof meta.stopped_at, "string", "a place is kept, never nothing");
  assert.equal(stoppedAt(meta, []), true);
  assert.equal(stoppedAt(meta, [answer("1:4")]), true, "no message of the person's since");
  assert.equal(stoppedAt(meta, [user("1:5")]), false, "a message since the stop");
});

test("messages order by their store entry, whatever conversation shows them", () => {
  // The store mints conversation and entry ids from one counter: a subagent's conversation (40) can have a number above
  // a root message (1:90) that came after the subagent's task (40:45).
  const atSubagent = [user("1:3"), user("40:45")];
  assert.equal(stoppedAt(stopMark(atSubagent), [...atSubagent, user("1:90")]), false, "the root message is newer than the task");
  const atRoot = [user("1:3"), user("40:45"), user("1:90")];
  assert.equal(stoppedAt(stopMark(atRoot), atRoot), true, "the task is older than the stopped message");
});

test("the run's status follows the stop when a compaction left no message of the person's shown", () => {
  const meta = stopMark([user("1:3"), answer("1:4"), user("1:9")]);
  const summarized = [{ id: "1:14", kind: "phase", summary: "Summarized older context" }];
  const run = (fields) => ({ kind: "agentic", rows: summarized, submitted: 0, working: false, meta, ...fields });
  assert.deepEqual(statusOf(run({})), { status: "input_required", state: "idle" }, "stopped, never queued");
  assert.deepEqual(statusOf(run({ working: true })), { status: "input_required", state: "idle" }, "its process still ending the turn");
  assert.equal(statusOf(run({ submitted: 1 })).state, "working", "a message sent since the stop is being worked on");
  assert.deepEqual(statusOf(run({ meta: { title: "t", created_at: "2026-01-01T00:00:00.000Z" }, rows: [] })), { status: "queued", state: "working" }, "a run never stopped, with no message shown yet, is queued");
  // No rows at all is a run not shown yet (a server adopting it, before its first snapshot), not a compaction, which
  // always shows its summary: an old stop says nothing about it until its rows arrive.
  assert.deepEqual(statusOf(run({ rows: [] })), { status: "queued", state: "working" }, "a stopped run not shown yet is queued");
});
