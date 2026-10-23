// The change log behind the timeline cursor, on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChangeClock, RowLog } from "../dist/rows.js";

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
