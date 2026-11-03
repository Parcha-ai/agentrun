// One row per action: a tool call is one row, its call's `tool_use` row, keyed by its tool_use_id. The row says the call
// while it runs (tool_status "running"), and its outcome once it ends ("success", "failed", a quiet "missing" for a read
// of a path the run never wrote, or "interrupted" when no result ever came), with a one-line result in its summary and
// the result, readable, in its preview. No call shows a second row: no tool_result row, no "Saved" row (the write's row
// has its path), no second "interrupted" row. Labels never show a wire name or an absolute path under the run's
// workspace. A settled run's usage row is its total. The run's metrics count each action once.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runMetricsOf, runMetricsWithDecisions, timelineOf, timelineReducer } from "../dist/timeline/index.js";
import { assistant, call, result, user } from "./timeline-support.mjs";

const failed = (callId, name, text, t) => result(callId, name, text, t, { isError: true });
const tools = (rows) => rows.filter((r) => r.kind === "tool_use" || r.kind === "tool_result");
const shown = (rows) => JSON.stringify(rows.map((r) => [r.id, r.kind, r.summary, r.tool_status]));

test("a call and its result are one row: its call's, with the outcome, a one-line result and the result in its preview; a write's row has its path and no Saved row follows", () => {
  const rows = timelineOf([
    user("Write a.md.", 0),
    assistant([call("w1", "write", { path: "a.md", content: "alpha" })], 1),
    result("w1", "write", "Successfully wrote 5 bytes to a.md", 2),
    assistant([{ type: "text", text: "Done." }], 3),
  ], { settled: true });
  const actions = tools(rows);
  assert.equal(actions.length, 1, shown(rows));
  const [row] = actions;
  assert.deepEqual([row.kind, row.tool_use_id, row.tool_status], ["tool_use", "w1", "success"], shown(rows));
  assert.match(row.summary, /^Wrote a\.md: \S/, "the action, then its one-line result");
  assert.equal(row.tool_result_preview, "Successfully wrote 5 bytes to a.md");
  assert.equal(row.path, "a.md");
  assert.deepEqual(rows.filter((r) => r.kind === "phase" && /^Saved /.test(r.summary ?? "")), [], shown(rows));
});

test("live, a call's row runs, then changes in place to its outcome: the same id and the same place", () => {
  const reducer = timelineReducer({ conversationId: 1 });
  reducer.apply([{ type: "message_end", entry: user("Read a.md.", 0) }, { type: "message_end", entry: assistant([call("r1", "read", { path: "a.md" })], 1) }]);
  const before = tools(reducer.rows());
  assert.deepEqual(before.map((r) => [r.kind, r.tool_status]), [["tool_use", "running"]], shown(reducer.rows()));
  const changed = reducer.apply([{ type: "entry_appended", entry: result("r1", "read", "alpha", 2) }]);
  const after = tools(reducer.rows());
  assert.deepEqual(after.map((r) => [r.id, r.seq, r.tool_status]), [[before[0].id, before[0].seq, "success"]], shown(reducer.rows()));
  assert.ok(changed.rows.some((r) => r.id === before[0].id), "the changed row is given back, to be served again");
});

test("a result stored before its call is that call's: one row, at the call, with the call's label", () => {
  const rows = timelineOf([
    user("Write two files.", 0),
    result("w1", "write", "Successfully wrote 5 bytes to a.md", 1),
    assistant([call("w1", "write", { path: "a.md", content: "alpha" }), call("w2", "write", { path: "b.md", content: "beta" })], 2),
    result("w2", "write", "Successfully wrote 4 bytes to b.md", 3),
    assistant([{ type: "text", text: "Wrote both." }], 4),
  ], { settled: true });
  assert.deepEqual(tools(rows).map((r) => [r.tool_use_id, r.tool_status, r.summary.split(":")[0]]), [["w1", "success", "Wrote a.md"], ["w2", "success", "Wrote b.md"]], shown(rows));
});

test("a call with no result is interrupted on its own row, and only at the end; a call with a result never is", () => {
  const entries = [
    user("Read both.", 0),
    assistant([call("r1", "read", { path: "a.md" }), call("r2", "read", { path: "b.md" })], 1),
    result("r1", "read", "alpha", 2),
  ];
  const rows = timelineOf(entries, { settled: true });
  assert.deepEqual(tools(rows).map((r) => [r.tool_use_id, r.tool_status]), [["r1", "success"], ["r2", "interrupted"]], shown(rows));
  assert.deepEqual(rows.filter((r) => r.id.includes(":interrupted:")), [], shown(rows));
  const reducer = timelineReducer({ conversationId: 1 });
  reducer.apply([{ type: "snapshot", entries }, { type: "run_start", inputs: [] }, { type: "run_end", inputs: [] }]);
  assert.deepEqual(tools(reducer.rows()).map((r) => [r.tool_use_id, r.tool_status]), [["r1", "success"], ["r2", "interrupted"]], shown(reducer.rows()));
});

test("a call's row says when it ended: ended_at, at or after its timestamp, once it has an outcome (an interrupted one too), null while it runs", () => {
  const ended = (row) => [row.tool_use_id, row.tool_status, row.ended_at === null ? null : Date.parse(row.ended_at) >= Date.parse(row.timestamp)];
  const entries = [
    user("Read both.", 0),
    assistant([call("r1", "read", { path: "a.md" }), call("r2", "read", { path: "b.md" })], 1),
    result("r1", "read", "alpha", 4),
  ];
  const live = timelineReducer({ conversationId: 1 });
  live.apply([{ type: "snapshot", entries }, { type: "run_start", inputs: [] }]);
  assert.deepEqual(tools(live.rows()).map(ended), [["r1", "success", true], ["r2", "running", null]], shown(live.rows()));
  assert.equal(tools(live.rows())[0].ended_at, "2026-10-15T20:14:04.000Z", "the moment its result came");
  const settled = timelineOf(entries, { settled: true, run: { startedAt: "2026-10-15T20:14:00.000Z", endedAt: "2026-10-15T20:14:09.000Z" } });
  assert.deepEqual(tools(settled).map(ended), [["r1", "success", true], ["r2", "interrupted", true]], shown(settled));
  assert.equal(tools(settled)[1].ended_at, "2026-10-15T20:14:09.000Z", "an interrupted call ended when its run did");
  const early = timelineOf([user("Go.", 0), result("w1", "write", "ok", 1), assistant([call("w1", "write", { path: "a.md" })], 2)], { settled: true });
  assert.deepEqual(tools(early).map(ended), [["w1", "success", true]], "a result stored before its call ends no earlier than the call");
});

test("a read of a path the run never wrote that finds nothing is a quiet 'not found'; one after the run wrote the path fails; the metrics count neither probe as an error", () => {
  const entries = [
    user("Look first.", 0),
    assistant([call("r1", "read", { path: "AGENTS.md" })], 1),
    failed("r1", "read", "ENOENT: no such file or directory, open 'AGENTS.md'", 2),
    assistant([call("w1", "write", { path: "notes.md", content: "x" })], 3),
    result("w1", "write", "Successfully wrote 1 bytes to notes.md", 4),
    assistant([call("r2", "read", { path: "notes.md" })], 5),
    failed("r2", "read", "ENOENT: no such file or directory, open 'notes.md'", 6),
    assistant([{ type: "text", text: "Done." }], 7),
  ];
  const rows = timelineOf(entries, { settled: true });
  assert.deepEqual(tools(rows).map((r) => [r.tool_use_id, r.tool_status]), [["r1", "missing"], ["w1", "success"], ["r2", "failed"]], shown(rows));
  assert.equal(tools(rows)[0].summary, "Read AGENTS.md: not found");
  assert.deepEqual(runMetricsOf(entries).tools, { read: { calls: 2, errors: 1 }, write: { calls: 1, errors: 0 } });
});

test("a read the run's own write makes failed counts as an error in the metrics too, however each names the file: an absolute path under the workspace or a relative one", () => {
  const work = "/data/runs/r1/work";
  const entries = [
    user("Write, then read it back.", 0),
    assistant([call("w1", "write", { path: `${work}/notes.md`, content: "x" })], 1),
    result("w1", "write", "Successfully wrote 1 bytes to notes.md", 2),
    assistant([call("r1", "read", { path: "notes.md" })], 3),
    failed("r1", "read", "ENOENT: no such file or directory, open 'notes.md'", 4),
    assistant([{ type: "text", text: "Done." }], 5),
  ];
  assert.deepEqual(tools(timelineOf(entries, { settled: true, workDir: work })).map((r) => [r.tool_use_id, r.tool_status]), [["w1", "success"], ["r1", "failed"]]);
  assert.deepEqual(runMetricsWithDecisions(entries, [], { workDir: work }).tools, { read: { calls: 1, errors: 1 }, write: { calls: 1, errors: 0 } }, "the metrics read the paths as the timeline does");
});

test("labels show neither a tool's wire name, nor 'Using tool:', nor an absolute path under the run's workspace", () => {
  const work = "/data/runs/r1/work";
  const rows = timelineOf([
    user("Go.", 0),
    assistant([call("w1", "mcp__hands__write", { path: `${work}/stats.py`, content: "x" }), call("x1", "Frobnicate", {})], 1),
    result("w1", "mcp__hands__write", `Successfully wrote 1 bytes to ${work}/stats.py`, 2),
    result("x1", "Frobnicate", "done", 3),
    assistant([{ type: "text", text: "Done." }], 4),
  ], { settled: true, workDir: work });
  const text = JSON.stringify(tools(rows));
  assert.doesNotMatch(text, /mcp__hands__|Using tool:/, shown(rows));
  assert.ok(!text.includes(work), `no path under ${work}: ${shown(rows)}`);
  assert.match(tools(rows)[0].summary, /^Wrote stats\.py: /, shown(rows));
  assert.match(tools(rows)[1].summary, /^Used Frobnicate/, shown(rows));
});

test("a result that is JSON reads as text in the preview: one field per line, its strings with their own line breaks", () => {
  const rows = timelineOf([
    user("Fetch it.", 0),
    assistant([call("f1", "web_fetch", { url: "https://www.python.org/" })], 1),
    result("f1", "web_fetch", JSON.stringify({ ok: true, url: "https://www.python.org/", status: 200, title: "Python", text: "line one\nline two" }), 2),
    assistant([{ type: "text", text: "Done." }], 3),
  ], { settled: true });
  const preview = tools(rows)[0].tool_result_preview;
  assert.match(preview, /^title: Python$/m, preview);
  assert.match(preview, /line one\nline two/, preview);
  assert.doesNotMatch(preview, /\\n|^\{/, preview);
});

test("a settled run's usage row is its total: cost, requests and the time from its start to its end", () => {
  const rows = timelineOf([user("Hi.", 0), assistant([{ type: "text", text: "Hello." }], 1)], { settled: true, run: { startedAt: "2026-11-03T10:00:00.000Z", endedAt: "2026-11-03T10:00:31.000Z" } });
  assert.equal(rows.at(-1).summary, "Total: $0.0100 · 1 model request · 31 s");
  const live = timelineOf([user("Hi.", 0), assistant([{ type: "text", text: "Hello." }], 1)]);
  assert.match(live.at(-1).summary, /^Cost so far: /);
});

test("the run's metrics count each action once: a result stored before its call is one call", () => {
  assert.deepEqual(runMetricsOf([
    user("Write two files.", 0),
    result("w1", "write", "Successfully wrote 5 bytes to a.md", 1),
    assistant([call("w1", "write", { path: "a.md", content: "alpha" }), call("w2", "write", { path: "b.md", content: "beta" })], 2),
    result("w2", "write", "Successfully wrote 4 bytes to b.md", 3),
  ]).tools, { write: { calls: 2, errors: 0 } });
});
