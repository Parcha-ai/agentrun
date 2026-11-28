// `runs timeline --follow` on a terminal: one line per row for a person, the run's own text unable to drive the
// terminal; piped, the pages as the server sent them. followTimeline runs in this process against a stream it is handed.
import assert from "node:assert/strict";
import test from "node:test";

import { followTimeline, rowLine } from "../lib/follow.mjs";

const ESC = "\u001b";

/** One server-sent event. */
const sse = (event, data, id) => `event: ${event}\ndata: ${JSON.stringify(data)}\n${id === undefined ? "" : `id: ${id}\n`}\n`;

/** A client whose every request answers the next of `streams` as an event stream; `out` is what it printed. */
function clientOf(streams, isTTY) {
  const out = [];
  const err = [];
  const asked = [];
  return {
    out,
    err,
    asked,
    fetch: async (path, init) => {
      asked.push(init.headers["last-event-id"]);
      const body = streams.shift();
      assert.ok(body !== undefined, "no request past the streams it was given");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    refused: () => assert.fail("nothing is refused here"),
    unreachable: (error) => error,
    io: { stdout: { isTTY, write: (text) => (out.push(String(text)), true) }, stderr: { isTTY: false, write: (text) => (err.push(String(text)), true) } },
  };
}

const row = (fields) => ({
  timestamp: "2026-11-28T12:34:56.789Z",
  created_at: "2026-11-28T12:34:56.789Z",
  summary: null,
  agent_label: null,
  tool_name: null,
  tool_use_id: null,
  tool_status: null,
  tool_input_preview: null,
  tool_result_preview: null,
  tool_result_size_bytes: null,
  text: null,
  ...fields,
});

const page = (fields) => ({ run_id: "r1", status: "working", state: "working", reset: false, rows: [], drop: [], next_after: 0, unchanged: false, has_more: false, final: false, cost: { usd: null, basis: "unpriced" }, ...fields });

const call = row({ id: "a", seq: 1, kind: "tool_use", tool_name: "bash", tool_input_preview: "ls -la" });
const said = row({ id: "b", seq: 2, kind: "text_block", summary: `Done.${ESC}[2J${ESC}]0;owned\u0007\nnext line ‮evil‬`, text: "ignored when there is a summary" });
const result = row({ id: "c", seq: 3, kind: "tool_result", tool_name: "bash", tool_status: null, tool_result_preview: "total 0" });
const usage = row({ id: "d", seq: 4, kind: "usage", summary: "model calls", usage: { usd: 0.01234, requests: 2 }, agent_label: "researcher" });

test("on a terminal each row prints once as a line, again only when it changes; the status when it changes, and on the final page with its cost; a reconnect and a reset print nothing twice", async () => {
  const first = sse("rows", page({ reset: true, rows: [call, said, result] }), "1") + sse("end", { reason: "reconnect" });
  const second =
    sse("rows", page({ reset: true, rows: [call, said, { ...result, tool_status: "failed" }] }), "2") +
    sse("rows", page({ status: "input_required", state: "waiting", rows: [usage] }), "3") +
    sse("rows", page({ status: "completed", state: "idle", rows: [] }), "4") +
    sse("rows", page({ status: "completed", state: "idle", final: true, rows: [], cost: { usd: 0.5, basis: "charge" } }), "5") +
    sse("end", { reason: "terminal" });
  const client = clientOf([first, second], true);
  const code = await followTimeline(client, "/runs/r1/timeline");
  assert.equal(code, 0, client.err.join(""));
  assert.deepEqual(client.asked, [undefined, "1"], "the reconnect resumed after the last event id");
  assert.deepEqual(client.out.join("").split("\n").slice(0, -1), [
    "12:34:56  tool_use  bash  ls -la",
    "12:34:56  text_block  Done. [2J ]0;owned next line evil",
    "12:34:56  tool_result  bash  total 0",
    "          run working",
    "12:34:56  tool_result  bash  failed  total 0",
    "12:34:56  [researcher]  usage  $0.0123  model calls",
    "          run input_required",
    "          run completed",
    "          run completed, $0.5000 (charge)",
  ]);
  assert.ok(!client.out.join("").includes(ESC) && !client.out.join("").includes("‮"), "no escape or bidi override reaches the terminal");
});

test("a line is cut at its limit with an ellipsis; a row with no time, summary or text still prints its kind", () => {
  const long = rowLine(row({ id: "e", seq: 5, kind: "final_answer", summary: "x".repeat(500) }));
  assert.equal(long.length, 200);
  assert.ok(long.startsWith("12:34:56  final_answer  xxx") && long.endsWith("…"), long);
  assert.equal(rowLine({ id: "f", seq: 6, kind: "waiting" }), "--:--:--  waiting");
  assert.equal(rowLine(row({ id: "g", seq: 7, kind: "thinking", text: "Let me look." })), "12:34:56  thinking  Let me look.", "the text when there is no summary");
});

test("piped, --follow prints each page as the server sent it, one line of JSON each", async () => {
  const pages = [page({ reset: true, rows: [call, said] }), page({ status: "completed", final: true, rows: [result] })];
  const stream = sse("rows", pages[0], "1") + sse("rows", pages[1], "2") + sse("end", { reason: "terminal" });
  const client = clientOf([stream], false);
  assert.equal(await followTimeline(client, "/runs/r1/timeline"), 0);
  assert.deepEqual(client.out.join("").trim().split("\n").map((line) => JSON.parse(line)), pages);
});
