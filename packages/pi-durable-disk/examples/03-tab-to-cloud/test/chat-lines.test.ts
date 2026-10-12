import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatItem } from "../tab/chat-view.ts";
import { echoedTools, isMuted, toolArgsLine } from "../tab/chat-lines.ts";

// A tool call is one quiet line: its name, then what it was given in a few words. The result opens on tap; a reply that repeats the result says it once.
test("a tool's arguments as a few words: the short values in order, a command as itself, nothing long", () => {
  assert.equal(toolArgsLine("set_color", JSON.stringify({ part: "legs", color: "red" })), "legs · red");
  assert.equal(toolArgsLine("do", JSON.stringify({ skill: "spin" })), "spin");
  assert.equal(toolArgsLine("bash", JSON.stringify({ command: "ls -la /workspace" })), "ls -la /workspace");
  assert.equal(toolArgsLine("write", JSON.stringify({ path: "robot.json", content: "x".repeat(500) })), "robot.json", "a long value is not a few words");
  assert.equal(toolArgsLine("set_legs", JSON.stringify({ pairs: 4 })), "4");
  assert.equal(toolArgsLine("x", ""), "");
  assert.equal(toolArgsLine("x", "not json at all"), "not json at all");
  assert.equal(toolArgsLine("x", JSON.stringify({ command: "y".repeat(300) })).length <= 80, true, "one line stays one line");
});

test("refusals and errors are muted, never alarms: the robot tools' 'Not done' and 'No change', and a call that failed", () => {
  const tool = (output: string, status: "done" | "error" | "interrupted" | "running" = "done") => ({ kind: "tool" as const, id: "t", name: "set_color", args: "{}", output, status });
  assert.equal(isMuted(tool("Not done: the legs cannot be that color.")), true);
  assert.equal(isMuted(tool("No change: the torso is already green.")), true);
  assert.equal(isMuted(tool("boom", "error")), true);
  assert.equal(isMuted(tool("interrupted", "interrupted")), true);
  assert.equal(isMuted(tool("The torso is now green.")), false);
  assert.equal(isMuted(tool("", "running")), false);
});

test("a reply that says what the tool just said is said once: the tool's result is not shown again", () => {
  const items: ChatItem[] = [
    { kind: "user", id: "u", text: "paint it" },
    { kind: "tool", id: "a", name: "set_color", args: "{}", output: "The torso is now green.", status: "done" },
    { kind: "assistant", id: "r", text: " The torso is now green. ", thinking: "", streaming: false },
    { kind: "tool", id: "b", name: "set_color", args: "{}", output: "The legs are now red.", status: "done" },
    { kind: "assistant", id: "r2", text: "Done: legs are red and the body is green.", thinking: "", streaming: false },
  ];
  assert.deepEqual([...echoedTools(items)], ["a"], "only the result the reply repeated word for word; a different reply keeps its tool's result");
});

import { moveLine, toolKind, editPairs, grepHits } from "../tab/chat-lines.ts";

// A move is one quiet line, never the notice the agent was given: "→ Modal VM · Jev 0.83" on the way out, "← your browser" on the way home.
const notice = (over: Record<string, unknown>) => ({ kind: "switch" as const, id: "n", text: "SYSTEM: you moved ...", switchId: "s", planned: true, ...over });
test("a move is one line: where it went and, when Jev decided, how sure; coming home is an arrow back", () => {
  assert.equal(moveLine(notice({ to: "a Modal VM", by: "jev", probability: 0.83 })), "→ Modal VM · Jev 0.83");
  assert.equal(moveLine(notice({ to: "a Daytona sandbox" })), "→ Daytona sandbox");
  assert.equal(moveLine(notice({ to: "your user's browser tab" })), "← your browser");
  assert.equal(moveLine(notice({ to: "your user's browser tab", by: "jev", probability: 0.9 })), "← your browser · Jev 0.90");
  assert.equal(moveLine(notice({ to: null })), "→ moved", "a notice that names no host still shows as a move, never as the notice's text");
  assert.doesNotMatch(moveLine(notice({ to: null })), /SYSTEM|you moved/);
});

test("which kind a tool call is: the pi tools by name, anything else is plain", () => {
  assert.deepEqual(["bash", "write", "edit", "read", "grep", "find", "ls", "set_color"].map(toolKind), ["bash", "write", "edit", "read", "grep", "find", "ls", "other"]);
});

test("an edit's changes: each oldText/newText pair of the call, in order; nothing for arguments that are not an edit", () => {
  assert.deepEqual(editPairs(JSON.stringify({ path: "a.ts", edits: [{ oldText: "x = 1", newText: "x = 2" }, { oldText: "y", newText: "z" }] })), { path: "a.ts", pairs: [{ oldText: "x = 1", newText: "x = 2" }, { oldText: "y", newText: "z" }] });
  assert.deepEqual(editPairs(JSON.stringify({ path: "a.ts", oldText: "p", newText: "q" })), { path: "a.ts", pairs: [{ oldText: "p", newText: "q" }] }, "the older single-pair shape too");
  assert.equal(editPairs("not json"), null);
  assert.equal(editPairs(JSON.stringify({ path: "a.ts" })), null);
});

test("grep hits: path, line and the matching text of each line; lines that are not hits are kept as plain lines", () => {
  const hits = grepHits("src/a.ts:12:const x = 1;\nsrc/b.ts:3:  return x;\n(2 matches)");
  assert.deepEqual(hits.slice(0, 2), [{ path: "src/a.ts", line: 12, text: "const x = 1;" }, { path: "src/b.ts", line: 3, text: "  return x;" }]);
  assert.deepEqual(hits[2], { path: null, line: null, text: "(2 matches)" });
  assert.deepEqual(grepHits(""), []);
});
