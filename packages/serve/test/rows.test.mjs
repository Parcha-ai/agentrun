// The change log behind the timeline cursor, on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { timelineReducer } from "@parcha/pi-durable-agent/timeline";
import { ChangeClock, RowLog } from "../dist/rows.js";
import { keepCommitted } from "../dist/runs.js";

const row = (id, summary = id, kind = "text_block") => ({ id, timestamp: "2026-10-16T00:00:00.000Z", created_at: "2026-10-16T00:00:00.000Z", kind, summary, agent_label: null, tool_name: null, tool_use_id: null, tool_status: null, tool_input_preview: null, tool_result_preview: null, tool_result_size_bytes: null, text: null });

test("after=N answers the current version of each row changed after N, and the ids dropped after it; 0 resets", () => {
  const log = new RowLog(new ChangeClock());
  log.setState("working/working");
  log.sync([row("a"), row("live")]);
  const first = log.page(0, 100);
  assert.equal(first.reset, true);
  assert.deepEqual(first.rows.map((r) => [r.id, r.seq]), [["a", 0], ["live", 1]]);
  log.sync([row("a", "a changed"), row("b")]);
  const second = log.page(first.next_after, 100);
  assert.equal(second.reset, false);
  assert.deepEqual(second.rows.map((r) => [r.id, r.seq, r.summary]), [["a", 0, "a changed"], ["b", 2, "b"]]);
  assert.deepEqual(second.drop, ["live"]);
  assert.ok(second.next_after > first.next_after);
  const end = log.page(second.next_after, 100);
  assert.deepEqual([end.unchanged, end.rows, end.drop], [true, [], []]);
  log.setState("completed/idle");
  assert.equal(log.page(second.next_after, 100).unchanged, false, "a status change is a change");
});

test("a row id that comes back after a drop is served under a new id and seq, so one id never names two seqs", () => {
  const log = new RowLog(new ChangeClock());
  log.sync([row("x"), row("0:live:text_block")]);
  const before = log.page(0, 100).next_after;
  log.sync([row("x")]);
  log.sync([row("x"), row("y"), row("0:live:text_block", "again")]);
  assert.deepEqual(log.rows().map((r) => [r.id, r.seq]), [["x", 0], ["y", 2], ["0:live:text_block~2", 3]]);
  const page = log.page(before, 100);
  assert.deepEqual(page.drop, ["0:live:text_block"]);
  assert.deepEqual(page.rows.map((r) => r.id), ["y", "0:live:text_block~2"]);
  assert.equal(page.rows.filter((r) => page.drop.includes(r.id)).length, 0, "no id is both dropped and sent in one page, so drop-then-upsert and upsert-then-drop agree");
});

test("a page stops at the limit with has_more, and the next one from its cursor has the rest; a cursor below this process resets", () => {
  const log = new RowLog(new ChangeClock());
  log.sync(["a", "b", "c", "d", "e"].map((id) => row(id)));
  const one = log.page(0, 2);
  assert.deepEqual([one.rows.map((r) => r.id), one.has_more], [["a", "b"], true]);
  const two = log.page(one.next_after, 2);
  assert.deepEqual([two.rows.map((r) => r.id), two.has_more, two.reset], [["c", "d"], true, false]);
  const three = log.page(two.next_after, 2);
  assert.deepEqual([three.rows.map((r) => r.id), three.has_more], [["e"], false]);
  assert.equal(log.page(1, 2).reset, true);
  assert.equal(log.page(Date.now() * 1000 - 10 ** 9, 2).reset, true);
});

test("a row `keep` names stays served when the rows no longer hold it; any other missing row is dropped", () => {
  const log = new RowLog(new ChangeClock());
  const row = (id, summary) => ({ id, kind: "user_message", summary, timestamp: "2026-01-01T00:00:00.000Z" });
  log.sync([row("0:1", "one"), row("0:live", "working"), row("0:2", "two")]);
  // A snapshot of a compacted conversation: only the newest row, and the live one ended.
  log.sync([row("0:2", "two")], (id) => id !== "0:live");
  assert.deepEqual(log.rows().map((r) => r.id), ["0:1", "0:2"], "the committed row stays, in its place; the live one is gone");
});

test("a live row that ended while the run's door was away goes with the next connection's snapshot; a committed one stays", () => {
  const log = new RowLog(new ChangeClock());
  const live = new Set();
  const user = (id, text) => ({ id, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }] }] });
  /** One connection to the door: a reducer of its own, as follow() makes. */
  const connect = (snapshot) => {
    const reducer = timelineReducer();
    reducer.apply([{ type: "snapshot", ...snapshot }]);
    const rows = reducer.rows();
    log.sync(rows, keepCommitted(live, rows, reducer.isLive));
  };
  connect({ entries: [user(2, "one"), user(5, "two")], generation: { retry: { at: Date.now() + 5_000, error: "rate limited" } } });
  assert.ok(log.rows().some((r) => r.kind === "waiting"), "the retry's wait is shown");
  // The connection drops, the retry ends while it is down, and the conversation compacts: the next snapshot holds
  // neither the wait nor the first message.
  connect({ entries: [user(5, "two")] });
  assert.deepEqual(log.rows().map((r) => r.kind), ["user_message", "user_message"], "the ended wait is gone; both messages stay");
});

test("the usage row is the timeline's last row: a row served after it, or its own change, moves it to the end", () => {
  const log = new RowLog(new ChangeClock());
  const usage = (summary) => row("1:usage", summary, "usage");
  log.sync([row("u", "You: hi", "user_message"), usage("Cost so far: $0.0001 over 1 model request")]);
  const first = log.page(0, 100);
  log.sync([row("u", "You: hi", "user_message"), row("t", "Wrote a file", "tool_use"), usage("Cost so far: $0.0001 over 1 model request")]);
  assert.deepEqual(log.rows().map((r) => r.id), ["u", "t", "1:usage"], "a row after it: it moves to the end, as it was");
  assert.deepEqual(log.page(first.next_after, 100).rows.map((r) => r.id), ["t", "1:usage"], "its move is a change: a cursor sees its new seq");
  log.sync([row("u", "You: hi", "user_message"), row("t", "Wrote a file", "tool_use"), row("r", "Wrote a file: ok", "tool_result"), usage("Cost so far: $0.0002 over 2 model requests")]);
  assert.deepEqual(log.rows().map((r) => r.id), ["u", "t", "r", "1:usage"]);
  const last = log.rows().at(-1).seq;
  assert.equal(log.sync(log.rows()), false, "nothing new: nothing moves");
  assert.equal(log.rows().at(-1).seq, last);
});

test("a full read's re-render of a big run with nothing changed since does no writes: 5,000 rows synced again take no change number and leave every row as it was", () => {
  const clock = new ChangeClock();
  const log = new RowLog(clock);
  const rows = Array.from({ length: 5_000 }, (_, i) => row(`1:${i}`, `step ${i}`));
  log.sync(rows);
  const [changes, last, served] = [clock.current, log.last, log.rows()];
  for (let i = 0; i < 5; i++) assert.equal(log.sync(rows), false, "nothing changed");
  // Each write takes a change number (a row added, changed or dropped): none was taken, and the log's last change stands.
  assert.deepEqual([clock.current - changes, log.last - last], [0, 0], "no writes");
  assert.deepEqual(log.rows(), served, "every row as it was");
  assert.equal(log.page(last, 10).unchanged, true, "a reader at the last change sees nothing new");
});
