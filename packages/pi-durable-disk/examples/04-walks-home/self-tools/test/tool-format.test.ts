import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CALL_CLOSE, CALL_OPEN, END_OF_TURN, TOOLS, TURN_MODEL, TURN_USER, callGrammar, clipResult, parseModelTurn, renderCall,
  renderModelTurn, renderPrompt, renderSpec, renderTranscript, selectTools, splitTurn, type Msg,
} from "../tool-format.ts";

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
