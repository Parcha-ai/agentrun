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
