import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalResult, codePointSpans, trainingRow, windowLast, CALL_CLOSE, CALL_OPEN, END_OF_TURN, TOOLS, TURN_MODEL, TURN_USER, callGrammar, clipResult, parseModelTurn, renderCall,
  renderModelTurn, renderPrompt, renderSpec, renderTranscript, selectTools, splitTurn, type Msg,
} from "../tab/tool-format.ts";

const user = (text: string): Msg => ({ role: "user", content: text });
const think = (thinking: string) => ({ type: "thinking" as const, thinking });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall" as const, id, name, arguments: args });
const said = (...content: unknown[]): Msg => ({ role: "assistant", content } as Msg);
const result = (id: string, name: string, text: string, isError = false): Msg =>
  ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError } as Msg);

const trajectory: Msg[] = [
  user("Make hello.txt say hi."),
  said(think("I will write the file."), call("c1", "write", { content: "hi\n", path: "hello.txt" })),
  result("c1", "write", "Successfully wrote 3 bytes to hello.txt"),
  said(think("It is written."), { type: "text", text: "hello.txt now says hi." }),
];

test("the first user turn carries the spec; the prompt is the transcript plus an open model turn", () => {
  const { text } = renderTranscript(TOOLS, trajectory.slice(0, 3));
  assert.ok(text.startsWith(`${TURN_USER}${renderSpec()}\n\nMake hello.txt say hi.<end_of_turn>\n`));
  assert.equal(renderPrompt(TOOLS, trajectory.slice(0, 3)), text + TURN_MODEL);
  assert.ok(text.endsWith(`${TURN_USER}<tool_result name="write">Successfully wrote 3 bytes to hello.txt</tool_result><end_of_turn>\n`));
});

test("the loss spans are exactly the model turns, each with its <end_of_turn>", () => {
  const { text, train } = renderTranscript(TOOLS, trajectory);
  assert.deepEqual(train.map(([a, b]) => text.slice(a, b)), [
    `<thinking>I will write the file.</thinking>\n${CALL_OPEN}{"name":"write","arguments":{"path":"hello.txt","content":"hi\\n"}}${CALL_CLOSE}${END_OF_TURN}`,
    `<thinking>It is written.</thinking>\nhello.txt now says hi.${END_OF_TURN}`,
  ]);
  for (const [a] of train) assert.equal(text.slice(a - TURN_MODEL.length, a), TURN_MODEL);
});

test("a call has one byte form: name first, arguments in schema order, nested objects too", () => {
  assert.equal(renderCall("edit", { edits: [{ newText: "b", oldText: "a" }], path: "x.js" }),
    '{"name":"edit","arguments":{"path":"x.js","edits":[{"oldText":"a","newText":"b"}]}}');
  assert.equal(renderCall("bash", { timeout: 5, command: "ls" }), '{"name":"bash","arguments":{"command":"ls","timeout":5}}');
  assert.equal(renderCall("read", { path: "a.txt", offset: null, limit: null }), '{"name":"read","arguments":{"path":"a.txt"}}');
});

test("parsing gives back what rendering wrote, for calls and for answers", () => {
  const c = { name: "edit", arguments: { path: "a.txt", edits: [{ oldText: "x\n", newText: "y \"q\"" }] } };
  const p = parseModelTurn(renderModelTurn({ thinking: "Fix it.", call: c }) + END_OF_TURN);
  assert.deepEqual(p, { thinking: "Fix it.", call: c, answer: "" });
  assert.deepEqual(parseModelTurn(renderModelTurn({ thinking: "Done.", answer: "All set." })), { thinking: "Done.", answer: "All set." });
});

test("a broken call is reported with what broke, never taken for an answer", () => {
  const kind = (s: string) => parseModelTurn(`<thinking>t</thinking>\n${s}`).problem?.kind;
  assert.equal(kind(`${CALL_OPEN}{"name":"write","arguments":{"path":"a"}}${CALL_CLOSE}`), "bad-args");
  assert.equal(kind(`${CALL_OPEN}{"name":"rm","arguments":{}}${CALL_CLOSE}`), "unknown-tool");
  assert.equal(kind(`${CALL_OPEN}{"name":"bash","arguments":{"command":"ls"}`), "no-close");
  assert.equal(kind(`${CALL_OPEN}{"name":"bash",}${CALL_CLOSE}`), "bad-json");
  assert.equal(kind(`${CALL_OPEN}{"name":"bash","arguments":{"command":"ls","cwd":"/"}}${CALL_CLOSE}`), "bad-args");
});

test("a string argument may contain the closing tag", () => {
  const args = { path: "t.txt", content: "a </tool_call> b" };
  const p = parseModelTurn(renderModelTurn({ thinking: "t", call: { name: "write", arguments: args } }));
  assert.deepEqual(p.call, { name: "write", arguments: args });
});

test("unclosed thinking before a call still parses as thinking", () => {
  const p = parseModelTurn(`<thinking>list it${CALL_OPEN}{"name":"bash","arguments":{"command":"ls"}}${CALL_CLOSE}`);
  assert.equal(p.thinking, "list it");
  assert.deepEqual(p.call, { name: "bash", arguments: { command: "ls" } });
});

test("several calls in one message become call/result pairs in call order, whatever order results arrive in", () => {
  const msgs: Msg[] = [
    user("Two files."),
    said(think("Write both."), call("a", "write", { path: "a", content: "1" }), call("b", "write", { path: "b", content: "2" })),
    result("b", "write", "wrote b"),
    result("a", "write", "wrote a"),
  ];
  const { text, train } = renderTranscript(TOOLS, msgs);
  const order = [...text.matchAll(/<start_of_turn>(user|model)\n/g)].map((m) => m[1]);
  assert.deepEqual(order, ["user", "model", "user", "model", "user"]);
  assert.ok(text.indexOf('"path":"a"') < text.indexOf("wrote a"));
  assert.ok(text.indexOf("wrote a") < text.indexOf('"path":"b"'));
  assert.ok(text.indexOf('"path":"b"') < text.indexOf("wrote b"));
  assert.equal(train.length, 2);
});

test("failed tools are marked; long output is cut in the middle", () => {
  const { text } = renderTranscript(TOOLS, [user("x"), said(think("t"), call("c", "read", { path: "nope" })), result("c", "read", "ENOENT", true)]);
  assert.ok(text.includes('<tool_result name="read" error="true">ENOENT</tool_result>'));
  const long = "a".repeat(1000) + "b".repeat(1000);
  const cut = clipResult(long, 100);
  assert.ok(cut.startsWith("a".repeat(65)) && cut.endsWith("b".repeat(35)) && cut.includes("1900 characters cut"));
});

test("the host's tools must have the arguments the format was trained on", () => {
  const pi = [
    { name: "read", parameters: { properties: { path: {}, offset: {}, limit: {} } } },
    { name: "bash", parameters: { properties: { command: {}, timeout: {} } } },
    { name: "grep", parameters: { properties: { pattern: {} } } },
  ];
  assert.deepEqual(selectTools(pi).map((t) => t.name), ["read", "bash"]);
  assert.throws(() => selectTools([{ name: "edit", parameters: { properties: { path: {}, oldText: {}, newText: {} } } }]), /edit/);
});

test("splitTurn keeps the call body's exact bytes for an identity check", () => {
  const body = '{"name":"bash","arguments":{"command":"node app.js"}}';
  assert.deepEqual(splitTurn(`<thinking>Run it.</thinking>\n${CALL_OPEN}${body}${CALL_CLOSE}`), { thinking: "Run it.", call: body, answer: "" });
});

test("the grammar names every tool and ends with the closing tag", () => {
  const g = callGrammar();
  for (const t of TOOLS) assert.ok(g.includes(`{\\"name\\":\\"${t.name}\\",\\"arguments\\":`), t.name);
  assert.match(g, /^root ::= \(.*\) "<\/tool_call>"$/m);
  assert.ok(g.includes('edit-args-obj ::= "{" "\\"path\\":" string ",\\"edits\\":" "[" edit-args-edits-item-obj ("," edit-args-edits-item-obj)* "]" "}"'));
});

// The same events through both pi stacks: pi-coding-agent's tools (training) and pi-durable's Harness on the tab's
// computer (texts measured there by D3, 2026-10-11).
test("tool results read the same from pi-coding-agent and from pi-durable's Harness", () => {
  const same = (name: string, coding: string, durable: string, want: string) => {
    assert.equal(canonicalResult(name, coding), want, `pi-coding-agent ${name}`);
    assert.equal(canonicalResult(name, durable), want, `pi-durable ${name}`);
  };
  same("bash", "hi\n", "hi\n", "hi");
  same("bash", "(no output)", "", "(no output)");
  same("bash", "out\n\n\nCommand exited with code 3", "out\n<harness>\n[error] Command exited with code 3\n</harness>", "out\n\nCommand exited with code 3");
  same("bash", "(no output)\n\nCommand exited with code 3", "<harness>\n[error] Command exited with code 3\n</harness>", "(no output)\n\nCommand exited with code 3");
  same("bash", "bash: line 1: grep: command not found\n\n\nCommand exited with code 127", "bash: line 1: grep: command not found\n<harness>\n[error] Command exited with code 127\n</harness>",
    "bash: line 1: grep: command not found\n\nCommand exited with code 127");
  same("read", "ENOENT: no such file or directory, access '/workspace/missing.txt'", "<harness>\n[error] /workspace/missing.txt: not found\n</harness>", "/workspace/missing.txt: not found");
  same("edit", "Could not find the exact text in w.txt. The old text must match exactly including all whitespace and newlines.",
    "<harness>\n[error] Could not find the exact text in w.txt. The old text must match exactly including all whitespace and newlines.\n</harness>",
    "Could not find the exact text in w.txt. The old text must match exactly including all whitespace and newlines.");
  same("write", "Successfully wrote to w.txt", "Successfully wrote to w.txt", "Successfully wrote to w.txt");
  assert.equal(canonicalResult("read", "HI\nworld\n"), "HI\nworld\n");
});

test("a node crash keeps its message and the user's frames, not the runtime's", () => {
  const tab = ["Failed to execute builtin 'internal/main/eval_string':", "Error: x", "    at Proxy.eval (http://127.0.0.1:8080/wasmer/pkg/snippets/a.js:1:1)",
    "    at http://127.0.0.1:8080/wasmer/pkg/snippets/b.js:2:2", "Node.js v24.13.2", "<harness>", "[error] Command exited with code 1", "</harness>"].join("\n");
  const linux = ["/workspace/app.js:1", "throw new Error(\"x\")", "^", "", "Error: x", "    at Object.<anonymous> (/workspace/app.js:1:7)",
    "    at Module._compile (node:internal/modules/cjs/loader:1554:14)", "", "Node.js v24.13.1", "", "", "Command exited with code 1"].join("\n");
  assert.equal(canonicalResult("bash", tab), "Error: x\n\nCommand exited with code 1");
  assert.equal(canonicalResult("bash", linux), "/workspace/app.js:1\nthrow new Error(\"x\")\n^\n\nError: x\n    at Object.<anonymous> (/workspace/app.js:1:7)\n\nCommand exited with code 1");
});

test("long bash output keeps its first and last ten lines", () => {
  const seq = Array.from({ length: 50 }, (_, i) => String(i + 1)).join("\n") + "\n";
  assert.equal(canonicalResult("bash", seq), [...Array.from({ length: 10 }, (_, i) => String(i + 1)), "[... 30 lines cut ...]", ...Array.from({ length: 10 }, (_, i) => String(i + 41))].join("\n"));
  const file = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(canonicalResult("read", file), file);
});

test("the last window keeps the previous request and final answer, not its loop", () => {
  const task1: Msg[] = [user("Make hello.js print hi."), said(think("Write it."), call("c1", "write", { path: "hello.js", content: "console.log('hi')\n" })),
    result("c1", "write", "Successfully wrote to hello.js"), said(think("Done."), { type: "text", text: "hello.js prints hi." })];
  const w = windowLast([...task1, user("Run it again.")]);
  assert.deepEqual(w.map((m) => m.role), ["user", "assistant", "user"]);
  const { text } = renderTranscript(TOOLS, w);
  assert.ok(text.includes("Make hello.js print hi.<end_of_turn>\n<start_of_turn>model\n<thinking>Done.</thinking>\nhello.js prints hi.<end_of_turn>\n<start_of_turn>user\nRun it again."));
  assert.ok(!text.includes('"path":"hello.js"'), "task 1's call is not in the window");
  // A previous task that stopped on a call is left out; so is anything before the previous task.
  assert.deepEqual(windowLast([...task1.slice(0, 2), user("Next.")]).map((m) => m.role), ["user"]);
  assert.equal(windowLast([user("a"), said(think("t"), { type: "text", text: "A" }), ...task1, user("b")])[0], task1[0]);
  // A previous answer from another model (the cloud's) is left out.
  assert.deepEqual(windowLast([...task1, user("Run it again.")], () => false).map((m) => m.role), ["user"]);
});

test("go_online takes no arguments and is one byte form", () => {
  assert.equal(renderCall("go_online", {}), '{"name":"go_online","arguments":{}}');
  assert.deepEqual(parseModelTurn(`<thinking>Training needs the cloud.</thinking>\n${CALL_OPEN}{"name":"go_online","arguments":{}}${CALL_CLOSE}`).call, { name: "go_online", arguments: {} });
  assert.ok(callGrammar().includes('go-online-args-obj ::= "{" "}"'));
  // GBNF rule names: letters, digits and hyphens only.
  for (const line of callGrammar().split("\n").filter(Boolean)) assert.match(line, /^[A-Za-z0-9-]+ ::= /);
});

test("training spans on disk are code points, so an emoji before a model turn cannot shift the loss", () => {
  const msgs: Msg[] = [user("Make art.txt say 🌉🌕 and stop."), said(think("Writing 🌉."), call("c1", "write", { path: "art.txt", content: "🌉🌕\n" })),
    result("c1", "write", "Successfully wrote to art.txt"), said(think("Done 🌕."), { type: "text", text: "art.txt says 🌉🌕." })];
  const { text, train } = renderTranscript(TOOLS, msgs);
  const row = trainingRow(text, train);
  assert.equal(row.units, "codepoint");
  const cps = Array.from(text);
  // Slicing by code points (as Python does) gives exactly the model turns that the UTF-16 spans mark.
  assert.deepEqual(row.train.map(([a, b]) => cps.slice(a, b).join("")), train.map(([a, b]) => text.slice(a, b)));
  assert.notDeepEqual(row.train, train);
  assert.deepEqual(codePointSpans("abc", [[0, 3]]), [[0, 3]]);
});
