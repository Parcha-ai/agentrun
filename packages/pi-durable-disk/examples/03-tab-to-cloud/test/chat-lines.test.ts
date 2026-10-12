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
  assert.equal(moveLine(notice({ to: "a Modal VM", by: "placement", probability: 0.83 })), "→ Modal VM · Jev 0.83");
  assert.equal(moveLine(notice({ to: "a Daytona sandbox" })), "→ Daytona sandbox");
  assert.equal(moveLine(notice({ to: "your user's browser tab" })), "← your browser");
  assert.equal(moveLine(notice({ to: "your user's browser tab", by: "placement", probability: 0.9 })), "← your browser · Jev 0.90");
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

import { tailLines } from "../tab/chat-lines.ts";

// A long output (training logs) shows its last lines and says how many came before, until it is opened in full.
test("the tail of a long output: the last lines, and how many were left out; a short output is whole", () => {
  const log = Array.from({ length: 30 }, (_, i) => `step ${i + 1}`).join("\n");
  const t = tailLines(log, 8);
  assert.equal(t.text, Array.from({ length: 8 }, (_, i) => `step ${i + 23}`).join("\n"));
  assert.equal(t.hidden, 22);
  assert.deepEqual(tailLines("a\nb\nc", 8), { text: "a\nb\nc", hidden: 0 });
  assert.deepEqual(tailLines("a\nb\nc\n", 8), { text: "a\nb\nc", hidden: 0 }, "a trailing newline is not a line");
  assert.deepEqual(tailLines("", 8), { text: "", hidden: 0 });
  assert.equal(tailLines("x\n\n\ny", 2).text, "\ny", "blank lines inside count as lines");
});

import { WriteMemory } from "../tab/write-memory.ts";
import { hasBody } from "../tab/tool-body.ts";
import { Latest } from "../tab/latest.ts";

const start = (name: string, id: string, args: Record<string, unknown> = {}) => ({ type: "tool_execution_start", toolName: name, toolCallId: id, args });
test("a write's diff is against what the page saw written, and it forgets what another tool could have changed", () => {
  const m = new WriteMemory();
  assert.deepEqual(m.observe(start("write", "w1", { path: "a.ts", content: "one" })), { before: undefined });
  assert.deepEqual(m.observe(start("write", "w2", { path: "a.ts", content: "two" })), { before: "one" });
  m.observe(start("bash", "b1", { command: "sed -i s/two/three/ a.ts" }));
  assert.deepEqual(m.observe(start("write", "w3", { path: "a.ts", content: "four" })), { before: undefined }, "a bash may have changed the file: the page does not claim to know it");
  m.observe(start("read", "r1", { path: "a.ts" }));
  assert.deepEqual(m.observe(start("write", "w4", { path: "a.ts", content: "five" })), { before: "four" }, "a read changes nothing");
  m.observe({ type: "tool_execution_end", toolCallId: "w4", isError: true });
  assert.deepEqual(m.observe(start("write", "w5", { path: "a.ts", content: "six" })), { before: undefined }, "a write that failed is not what the file holds");
});

test("only the latest request is current", async () => {
  const gate = new Latest();
  const first = gate.next();
  const second = gate.next();
  assert.equal(gate.current(first), false);
  assert.equal(gate.current(second), true);
});

test("whether a call has anything to open is known without drawing it (a diff is drawn when its row is opened)", () => {
  const t = (name: string, args: unknown, output = "", status: "done" | "running" = "done") => ({ kind: "tool" as const, id: "x", name, args: JSON.stringify(args), output, status });
  assert.equal(hasBody(t("write", { path: "a.ts", content: "x" }), { showOutput: true }), true);
  assert.equal(hasBody(t("edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }), { showOutput: true }), true);
  assert.equal(hasBody(t("bash", { command: "ls" }), { showOutput: true }), true);
  assert.equal(hasBody(t("grep", { pattern: "x" }, "a.ts:1:x"), { showOutput: false }), true);
  assert.equal(hasBody(t("set_color", { part: "legs", color: "red" }, "The legs are now red."), { showOutput: true }), true);
  assert.equal(hasBody(t("set_color", { part: "legs", color: "red" }, "The legs are now red."), { showOutput: false }), false, "the reply says it once: nothing to open");
  assert.equal(hasBody(t("set_color", {}, "", "running"), { showOutput: true }), false);
});

import { ChatView } from "../tab/chat-view.ts";
test("a host's notice to the agent (an env.* kind that is not a move) never shows in the chat, and a real user line does", () => {
  const view = new ChatView();
  view.apply({ type: "snapshot", entries: [
    { id: "1", kind: "pi.user", model: [{ role: "user", content: "hello" }] },
    { id: "2", kind: "env.checkin", model: [{ role: "user", content: "[from the server] You are back in your user's browser..." }], data: {} },
    { id: "3", kind: "env.switch", model: [{ role: "user", content: "SYSTEM NOTICE" }], data: { switchId: "s", facts: { label: "a Modal VM" } } },
  ], tools: [], generation: undefined, run: undefined } as never);
  assert.deepEqual(view.items().map((i) => i.kind), ["user", "switch"], "the check-in prompt is hidden; the move stays (drawn as one line)");
});

// The harness appends its diagnostics to a tool result's content as a rendered <harness> block, and keeps them typed in the entry's data. The page reads the typed list and drops exactly that rendered block.
const harnessBlock = (d: { severity: string; message: string }[]) => `<harness>\n${d.map((x) => `[${x.severity}] ${x.message}`).join("\n")}\n</harness>`;
test("a failed command is its own output plus the harness's typed diagnostics; the <harness> wrapper is never in the output", () => {
  const diagnostics = [{ severity: "error", code: "tool_error", message: "Command exited with code 1" }];
  const view = new ChatView();
  view.apply({ type: "snapshot", entries: [
    { id: "a", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "cp x y" } }] }] },
    { id: "r", kind: "pi.tool-result", data: { diagnostics }, model: [{ role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true, content: [{ type: "text", text: "cp: cannot create 'y'\n" }, { type: "text", text: harnessBlock(diagnostics) }] }] },
  ], tools: [], generation: undefined, run: undefined } as never);
  const tool = view.items().find((i) => i.kind === "tool") as Extract<ReturnType<ChatView["items"]>[number], { kind: "tool" }>;
  assert.equal(tool.output, "cp: cannot create 'y'\n", "the command's own output, without the wrapper");
  assert.equal(tool.status, "error");
  assert.deepEqual(tool.diagnostics, [{ severity: "error", code: "tool_error", message: "Command exited with code 1" }], "the typed diagnostics ride on the item");
});

test("a result with no diagnostics is untouched, and a trailing block that is not the harness's rendering of its diagnostics stays", () => {
  const view = new ChatView();
  view.apply({ type: "snapshot", entries: [
    { id: "a", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "echo" } }, { type: "toolCall", id: "c2", name: "bash", arguments: { command: "echo" } }] }] },
    { id: "r1", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "<harness>\nnot ours\n</harness>" }] }] },
    { id: "r2", kind: "pi.tool-result", data: { diagnostics: [{ severity: "warn", code: "truncated", message: "Output truncated" }] }, model: [{ role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "lots" }, { type: "text", text: "<harness>\n[warn] something else\n</harness>" }] }] },
  ], tools: [], generation: undefined, run: undefined } as never);
  const tools = view.items().filter((i) => i.kind === "tool") as { output: string; diagnostics?: unknown[] }[];
  assert.equal(tools[0]!.output, "<harness>\nnot ours\n</harness>", "no diagnostics in the entry: nothing is removed");
  assert.equal(tools[1]!.output, "lots<harness>\n[warn] something else\n</harness>", "a block that is not the rendering of the entry's own diagnostics is kept");
  assert.equal(tools[1]!.diagnostics?.length, 1);
});

import { ellipsize } from "../tab/hint.ts";
test("a hint too long for its field is cut to the field's width with an ellipsis; one that fits is left alone", () => {
  const w = (s: string) => s.length * 10; // a fake measure: 10 px a character
  assert.equal(ellipsize("Tell the robot what to do", 400, w), "Tell the robot what to do");
  assert.equal(ellipsize("the session is open; the robot's brain is loading", 200, w), "the session is open…", "the longest beginning that fits with the ellipsis (20 characters of 10 px)");
  assert.equal(ellipsize("abc", 5, w), "…", "too narrow for anything: just the ellipsis");
});

import { fitPlaceholder } from "../tab/hint.ts";
test("the field's own placeholder is kept until a hint has been set; a set hint is fitted to the room there is", () => {
  const w = (s: string) => s.length * 10;
  assert.equal(fitPlaceholder("Ask the agent to write something…", "", 500, w), "Ask the agent to write something…", "a page that never sets a hint keeps the HTML's");
  assert.equal(fitPlaceholder("Ask the agent to write something…", "", 0, w), "Ask the agent to write something…", "even while the field is hidden");
  assert.equal(fitPlaceholder("old", "Tell the robot what to do", 0, w), "Tell the robot what to do", "no room measured yet (the field is hidden): the whole hint, fitted when it is shown");
  assert.equal(fitPlaceholder("old", "the session is open; the robot's brain is loading", 200, w), "the session is open…");
});

test("a read says which lines, not two bare numbers: the typed offset and limit as a range", () => {
  assert.equal(toolArgsLine("read", JSON.stringify({ path: "robot/body.json", offset: 1, limit: 70 })), "robot/body.json · lines 1–70");
  assert.equal(toolArgsLine("read", JSON.stringify({ path: "a.ts", offset: 41, limit: 20 })), "a.ts · lines 41–60");
  assert.equal(toolArgsLine("read", JSON.stringify({ path: "a.ts", limit: 30 })), "a.ts · lines 1–30");
  assert.equal(toolArgsLine("read", JSON.stringify({ path: "a.ts", offset: 100 })), "a.ts · from line 100");
  assert.equal(toolArgsLine("read", JSON.stringify({ path: "a.ts" })), "a.ts", "no range: just the file");
  assert.equal(toolArgsLine("set_legs", JSON.stringify({ pairs: 4 })), "4", "other tools keep their values");
});

test("a long path is shortened from the front so the lines it covers stay", () => {
  const path = `work/skills/${"deeply/nested/".repeat(8)}walk/skill.json`;
  assert.ok(path.length > 100);
  const line = toolArgsLine("read", JSON.stringify({ path, offset: 1, limit: 70 }));
  assert.ok(line.endsWith(" · lines 1–70"), line);
  assert.ok(line.length <= 80, `${line.length}`);
  assert.ok(line.startsWith("…/") && line.includes("walk/skill.json"), "the tail of the path, from a folder boundary");
  const bare = toolArgsLine("read", JSON.stringify({ path }));
  assert.ok(bare.startsWith("…/") && bare.endsWith("walk/skill.json") && bare.length <= 80, "no range: the same front cut");
});

import { callsLabel } from "../tab/chat-lines.ts";
test("a thread's call count agrees with its number", () => {
  assert.deepEqual([0, 1, 2, 12].map(callsLabel), ["0 calls", "1 call", "2 calls", "12 calls"]);
});

import { brainText } from "../tab/chat-view.ts";
import { BRAIN_CHECKIN } from "../tab/brain-kinds.ts";
test("the check-in is one quiet line from its typed fields: back on the server, and how many files came with it", () => {
  assert.equal(brainText(BRAIN_CHECKIN, { files: 1 }), "↑ back on the server · 1 file synced");
  assert.equal(brainText(BRAIN_CHECKIN, { files: 3 }), "↑ back on the server · 3 files synced");
  assert.equal(brainText(BRAIN_CHECKIN, { files: 0 }), "↑ back on the server");
  assert.equal(brainText(BRAIN_CHECKIN, {}), "↑ back on the server", "no count, none claimed");
});

import { driverLabel, movesAfterTheirMessage, pendingEchoes, placementLine, sentBase, sentState, type Sent } from "../tab/chat-lines.ts";

const user = (id: string, text: string): ChatItem => ({ kind: "user", id, text });
const reply = (id: string): ChatItem => ({ kind: "assistant", id, text: "ok", thinking: "", streaming: false });
const move = (id: string, by: string | null): ChatItem => ({ kind: "switch", id, text: "t", switchId: id, planned: true, to: "a Modal VM", by, probability: 0.98 });

test("a move Jev decided for a message reads after that message, not after the reply before it", () => {
  const written = [user("u1", "one"), reply("a1"), move("m1", "placement"), user("u2", "two"), reply("a2")];
  assert.deepEqual(movesAfterTheirMessage(written).map((i) => i.id), ["u1", "a1", "u2", "m1", "a2"]);
});

test("a move nobody decided for a message stays where it was written", () => {
  const written = [user("u1", "one"), reply("a1"), move("m1", null), user("u2", "two")];
  assert.deepEqual(movesAfterTheirMessage(written).map((i) => i.id), ["u1", "a1", "m1", "u2"]);
});

test("a placed move with a reply after it (no message of its own) is left alone", () => {
  const written = [user("u1", "one"), move("m1", "jev"), reply("a1")];
  assert.deepEqual(movesAfterTheirMessage(written).map((i) => i.id), ["u1", "m1", "a1"]);
});

const sent = (requestId: string, text: string, base: number, stage: Sent["stage"] = "sending"): Sent => ({ requestId, text, base, stage });

test("a line is shown as sent until the transcript holds it", () => {
  assert.deepEqual(pendingEchoes([user("u1", "hi")], [sent("r1", "make a dino", 0)]).map((s) => s.requestId), ["r1"]);
  assert.deepEqual(pendingEchoes([user("u1", "hi"), move("m", "placement")], [sent("r1", "hi", 0)]).map((s) => s.requestId), [], "held: the same text is now in the transcript");
});

test("the same text sent twice is two lines: each leaves when its own copy arrives", () => {
  const items = [user("u1", "go")];
  const first = sent("r1", "go", sentBase([], [], "go"));
  const second = sent("r2", "go", sentBase([], [first], "go"));
  assert.deepEqual(pendingEchoes(items, [first, second]).map((s) => s.requestId), ["r2"]);
  assert.deepEqual(pendingEchoes([...items, user("u2", "go")], [first, second]).map((s) => s.requestId), []);
  assert.equal(sentBase([user("u0", "go")], [], "go"), 1, "an earlier identical line already held counts");
});

test("a sent line says where it is: sending, Jev deciding, then the move or nothing", () => {
  assert.equal(sentState(sent("r", "x", 0)), "sending…");
  assert.equal(sentState(sent("r", "x", 0, "deciding")), "Jev deciding…");
  assert.equal(sentState({ ...sent("r", "x", 0, "decided"), move: placementLine("a Modal VM", 0.98) }), "→ Modal VM · Jev 0.98");
  assert.equal(sentState(sent("r", "x", 0, "decided")), "", "Jev kept it where it was: no move line");
  assert.equal(placementLine("your browser", null), "← your browser");
});

test("the header names the model that answers, by what the driver is", () => {
  assert.equal(driverLabel({ local: null, cloud: "gpt-6-sol" }), "gpt-6-sol");
  assert.equal(driverLabel({ local: null, cloud: "openai/gpt-6-sol" }), "gpt-6-sol");
  assert.equal(driverLabel({ local: "v5 · 0.8B", cloud: "gpt-6-sol" }), "v5 · 0.8B in this tab");
  assert.equal(driverLabel({ local: null, cloud: "" }), "");
});
