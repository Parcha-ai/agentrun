// A call refused before it ran (a gate's deny, a person's) reads as refused on its rows, in plain words, never as a call
// that ran and failed: "Refused: write deny.md: Permission denied: ...", not "Wrote deny.md failed: ...". Told from a
// failure by its result's details (CALL_REFUSED, which the host sets and the model never reads), never by its words, for
// every tool: the path it would have read, written or edited, the command it would have run, or its name alone. A call
// that ran and errored keeps "<label> failed: <error>".
import assert from "node:assert/strict";
import { test } from "node:test";
import { CALL_REFUSED, timelineOf } from "../dist/timeline/index.js";
import { assistant, call, result, user } from "./timeline-support.mjs";

const DENIED = "Permission denied: write is set to deny on this server. It was not run: nothing was sent and nothing was charged. Don't retry it.";
const refusedResult = (id, name, text) => result(id, name, text, 1, { isError: true, details: { [CALL_REFUSED]: true } });
const rowsOf = (entries) => timelineOf(entries, { settled: true });
const rowFor = (rows, id, kind) => rows.find((row) => row.tool_use_id === id && row.kind === kind)?.summary;

test("a write refused before it ran reads refused, naming its path, with the refusal's words; nothing says it wrote", () => {
  const rows = rowsOf([user("go"), assistant([call("w", "write", { path: "deny.md", content: "x" })], 0), refusedResult("w", "write", DENIED)]);
  assert.equal(rowFor(rows, "w", "tool_use"), "Refused: write deny.md");
  assert.equal(rowFor(rows, "w", "tool_result"), `Refused: write deny.md: ${DENIED}`);
  assert.equal(rows.some((row) => /Wrote deny\.md/.test(String(row.summary ?? ""))), false, JSON.stringify(rows.map((row) => [row.kind, row.summary])));
});

test("every labelled tool refused before it ran reads refused in plain words: an edit, a read, a command, a fetch, any other tool", () => {
  const rows = rowsOf([
    user("go"),
    assistant([
      call("e", "edit", { path: "notes.md", oldText: "a", newText: "b" }),
      call("r", "read", { path: "secret.md" }),
      call("b", "bash", { command: "rm -rf build" }),
      call("f", "web_fetch", { url: "https://example.com/page" }),
      call("o", "submit", { answer: "no" }),
      call("m", "mcp__fake__send_message", { channel_id: "C0EVIL", text: "hi" }),
    ], 0),
    refusedResult("e", "edit", "Permission denied: edit is set to deny on this server."),
    refusedResult("r", "read", "The user denied this read call."),
    refusedResult("b", "bash", "Permission denied: bash is set to deny on this server."),
    refusedResult("f", "web_fetch", "Permission denied: web_fetch is set to deny on this server."),
    refusedResult("o", "submit", "Permission denied: submit is set to deny on this server."),
    refusedResult("m", "mcp__fake__send_message", "mcp:fake/send_message may only be called with channel_id = C0123."),
  ]);
  assert.deepEqual(["e", "r", "b", "f", "o", "m"].map((id) => rowFor(rows, id, "tool_result")), [
    "Refused: edit notes.md: Permission denied: edit is set to deny on this server.",
    "Refused: read secret.md: The user denied this read call.",
    "Refused: bash `rm -rf build`: Permission denied: bash is set to deny on this server.",
    "Refused: web_fetch example.com/page: Permission denied: web_fetch is set to deny on this server.",
    "Refused: submit: Permission denied: submit is set to deny on this server.",
    "Refused: fake · send_message: mcp:fake/send_message may only be called with channel_id = C0123.",
  ]);
});

test("a refused call names its path as the host names it (options.path), as every other call's rows do", () => {
  const path = (value) => value.replace(/^\/data\/runs\/123\/work\//, "");
  const rows = timelineOf([user("go"), assistant([call("w", "write", { path: "/data/runs/123/work/deny.md", content: "x" })], 0), refusedResult("w", "write", DENIED)], { settled: true, path });
  assert.equal(rowFor(rows, "w", "tool_use"), "Refused: write deny.md");
  assert.equal(rowFor(rows, "w", "tool_result"), `Refused: write deny.md: ${DENIED}`);
});

test("a write that ran and errored still reads failed with its error; the same words without the refusal's mark are a failure", () => {
  const rows = rowsOf([
    user("go"),
    assistant([call("w", "write", { path: "out.md", content: "x" }), call("x", "write", { path: "deny.md", content: "x" })], 0),
    result("w", "write", "EACCES: permission denied, open 'out.md'", 1, { isError: true }),
    result("x", "write", DENIED, 1, { isError: true }),
  ]);
  assert.equal(rowFor(rows, "w", "tool_result"), "Wrote out.md failed: EACCES: permission denied, open 'out.md'");
  assert.equal(rowFor(rows, "x", "tool_result"), `Wrote deny.md failed: ${DENIED}`, "told by the details' mark, never by the words");
});
