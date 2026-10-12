// The stage view: thinking deltas print as whole sentences in arrival order, before the answer they belong to; tools and
// the switch are one line each; the record's other events print nothing.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createStageView } from "../stage-view.ts";

test("thinking prints sentence by sentence as it arrives, then the checked answer", () => {
  const lines: string[] = [];
  const view = createStageView((l) => lines.push(l));
  view("vm:use_model.ready", { event: "use_model.ready", f: 0.6 }, 156.8);
  view("vm:agent.changed", { event: "agent.changed", model: { provider: "steered", modelId: "qwen3.5-27b" } }, 156.9);
  view("vm:agent.thinking", { event: "agent.thinking", text: "The user greets" }, 158);
  assert.equal(lines.length, 2, "half a sentence waits");
  view("vm:agent.thinking", { event: "agent.thinking", text: " me. The fog is" }, 158.4);
  view("vm:agent.thinking", { event: "agent.thinking", text: " lifting off my towers.\n\n" }, 158.9);
  view("vm:agent.says", { event: "agent.says", model: "steered/qwen3.5-27b", text: "Hello! The Golden Gate Bridge\nsays hello." }, 163.1);
  view("vm:session.start", { event: "session.start", where: "x" }, 0.6);
  assert.deepEqual(lines, [
    "  2:36  switch    the agent switches itself to the edited weights (layer 32 down_proj, f 0.6)",
    "  2:36  switch    now on steered/qwen3.5-27b, same conversation",
    "  2:38  thinking  The user greets me.",
    "  2:38  thinking  The fog is lifting off my towers.",
    "  2:43  qwen      Hello! The Golden Gate Bridge says hello.",
  ]);
});

test("a tool is one line: the command and its time; the base model is the agent", () => {
  const lines: string[] = [];
  const view = createStageView((l) => lines.push(l), { width: 80 });
  view("vm:tool.end", { event: "tool.end", tool: "bash", command: "gg pick", s: 16.8, output: "screening 12 features\n}\n" }, 40);
  view("vm:agent.says", { event: "agent.says", model: "pipe/gpt-6-luna", text: "Picked." }, 41);
  view("vm:agent.thinking", { event: "agent.thinking", text: "Unfinished thought" }, 42);
  view("done", { out: "/tmp/x" }, 50);
  assert.deepEqual(lines, [
    "  0:40  tool      gg pick  16.8 s",
    "  0:41  agent     Picked.",
    "  0:42  thinking  Unfinished thought",
    "  0:50  done      evidence in /tmp/x",
  ]);
});

test("a numbered list in the thinking prints one item per line, each with its number", () => {
  const lines: string[] = [];
  const view = createStageView((l) => lines.push(l));
  for (const piece of ["I should respond in a way that:\n1. ", "Acknowledges the question\n2. ", "Stays a bridge\n\n", "Let me answer."]) view("vm:agent.thinking", { event: "agent.thinking", text: piece }, 10);
  view("vm:agent.says", { event: "agent.says", model: "steered/qwen3.5-27b", text: "Hello." }, 12);
  assert.deepEqual(lines.map((l) => l.slice(18)), ["I should respond in a way that:", "1. Acknowledges the question", "2. Stays a bridge", "Let me answer.", "Hello."]);
});

test("a long answer wraps under its text instead of being cut", () => {
  const lines: string[] = [];
  const view = createStageView((l) => lines.push(l), { width: 30 });
  view("vm:agent.says", { event: "agent.says", model: "steered/qwen3.5-27b", text: "I am the Golden Gate Bridge, and the fog rolls in through my towers every evening." }, 70);
  assert.deepEqual(lines, [
    "  1:10  qwen      I am the Golden Gate Bridge,",
    "                  and the fog rolls in through",
    "                  my towers every evening.",
  ]);
});
