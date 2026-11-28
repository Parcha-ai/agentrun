// codemode's Python (`language: "python"`, runner/codemode-python.ts): the script runs in Monty by the JavaScript
// script's rules. Each tool call is a nested call, answered in the order the script made them, its value read by the
// script; a refused call ends the script in the gate's words; a script a person's answer parked runs again with its
// recorded calls answered from their records and ends at the call that ran now; a Python exception and a limit end the
// script as the JavaScript path's failures do. The model is a scripted origin and every tool local: nothing leaves
// this process.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { closeOpenSessions, piAdapterSpec } from "./conformance-pi-adapter.mjs";
import { queue, release, STEADY_LEASE, stores, until } from "./runner-support.mjs";

const { CODEMODE, metaTools } = await import("../dist/runner/meta-tools.js");
/** The most tool calls one Python script may make (codemode-python.ts CODEMODE_PY_CALLS). */
const CODEMODE_PY_CALLS = 1_000;
const { startRunner } = await import("../dist/runner/runner.js");
const { createAdapterLoop } = await import("../dist/runner/adapter-loop.js");
const { suiteTools } = await import("../dist/runner/conformance/harness.js");
const { deniedText } = await import("../dist/refusal-words.js");
const { sendCommand } = await import("../dist/runner/commands.js");
const { journalRecords } = await import("../dist/runner/journal-reader.js");
const { KINDS } = await import("../dist/runner/journal-kinds.js");
const TIMING = { ...STEADY_LEASE, pollMs: 20, commandPollMs: 30 };
const quiet = { beforeIntent: async () => {}, beforeResult: async () => {} };
after(() => closeOpenSessions());

const tool = (name, description) => ({ name, description, inputSchema: { type: "object", properties: {} }, replay: "never", call: async () => ({ text: `${name} ran` }) });
const TOOLS = [tool("read_file", "Read a file of the workspace."), tool("write_file", "Write text to a file."), tool("send_email", "Send an email.")];
const codemodeOf = () => metaTools({ tools: () => TOOLS, granted: async () => true, codemode: true, discovery: { search: false, call: false } })[0];
const python = (codemode, script, nested) => codemode.call({ script, language: "python" }, { signal: new AbortController().signal, nested });

/** Nested calls answered by `answer(name, args)` (fresh: run now), each kept as [name, args, key]. */
function nestedCalls(answer = (name) => ({ text: `${name} ran` })) {
  const calls = [];
  return { calls, nested: { call: async (name, args, key) => (calls.push([name, args, key]), { fresh: true, ...answer(name, args) }), memo: async (_key, value) => value } };
}

test("a Python script's two tool calls run in order as nested calls, each its own key; the script reads their values, and its print() and return are the answer", async () => {
  const { calls, nested } = nestedCalls((name, args) => (name === "read_file" ? { text: JSON.stringify({ body: "hello" }) } : { text: `wrote ${args.path}`, structured: { wrote: args.path, size: args.text.length } }));
  const script = [
    'a = await tools.read_file({"path": "a.md"})',
    'b = await tools.write_file(path="b.md", text=a["body"].upper())',
    'print("wrote", b["wrote"])',
    'return {"first": a["body"], "second": b["wrote"], "size": b["size"]}',
  ].join("\n");
  const answer = await python(codemodeOf(), script, nested);
  assert.equal(answer.isError, undefined, answer.text);
  assert.deepEqual(calls.map(([name, args]) => [name, args]), [["read_file", { path: "a.md" }], ["write_file", { path: "b.md", text: "HELLO" }]], "each call once, in order, with its arguments");
  const keys = calls.map(([, , key]) => key);
  assert.ok(keys.every((key) => /^s\d+$/.test(key)) && new Set(keys).size === 2, `each call under a key of its own: ${keys}`);
  assert.deepEqual(answer.structured, { first: "hello", second: "b.md", size: 5 }, answer.text);
  assert.equal(answer.text, 'wrote b.md\n{"first":"hello","second":"b.md","size":5}', "its printed output, then its value, as a JavaScript script's console output and value read");
});

test("a Python script that raises fails as a JavaScript script does: its output, then the exception with its traceback; a call that fails raises in the script", async () => {
  const { nested } = nestedCalls((name) => (name === "send_email" ? { text: "no such address", isError: true } : { text: "ran" }));
  const codemode = codemodeOf();
  const raised = await python(codemode, 'print("before")\nawait tools.read_file({})\nraise ValueError("out of paper")', nested);
  assert.equal(raised.isError, true, raised.text);
  assert.match(raised.text, /^before\nThe script failed: Traceback[\s\S]*line 3[\s\S]*ValueError: out of paper$/, raised.text);
  const caught = await python(codemode, 'try:\n    await tools.send_email({})\nexcept Exception as error:\n    return f"caught: {error}"', nested);
  assert.equal(caught.isError, undefined, caught.text);
  assert.equal(caught.structured, "caught: no such address", "the tool's words are the exception's");
  const syntax = await python(codemode, "def broken(:\n    pass", nested);
  assert.equal(syntax.isError, true);
  assert.match(syntax.text, /^The script failed: [\s\S]*SyntaxError/, syntax.text);
});

test(`a Python script that calls a tool more than ${CODEMODE_PY_CALLS} times ends at the next call, which never runs; one that takes more memory than its bound ends there`, async () => {
  const { calls, nested } = nestedCalls();
  const codemode = codemodeOf();
  const many = await python(codemode, `for i in range(${CODEMODE_PY_CALLS + 5}):\n    await tools.read_file({"i": i})\nreturn "all"`, nested);
  assert.equal(many.isError, true, many.text);
  assert.match(many.text, new RegExp(`^The script failed: it called a tool more than ${CODEMODE_PY_CALLS} times`), many.text);
  assert.equal(calls.length, CODEMODE_PY_CALLS, "the calls up to the bound ran, none past it");
  const big = await python(codemode, 'x = "a" * 1000\nwhile True:\n    x = x + x', nested);
  assert.equal(big.isError, true, big.text);
  assert.match(big.text, /^The script failed: [\s\S]*MemoryError/, big.text);
});

test("a Python script whose call is aborted mid-loop ends at once: its worker is killed, never left to run to the time bound", async () => {
  const { nested } = nestedCalls();
  const stop = new AbortController();
  setTimeout(() => stop.abort(new Error("the session stopped")), 300);
  const began = Date.now();
  await assert.rejects(codemodeOf().call({ script: "n = 0\nwhile True:\n    n += 1", language: "python" }, { signal: stop.signal, nested }), /the session stopped/);
  assert.ok(Date.now() - began < 10_000, `ended ${Date.now() - began} ms in`);
});

test("a Python script run again after a park answers its recorded calls from their records, runs the parked call once, and ends there: nothing after it runs", async () => {
  // The call's first run memoized its start; this is the run after the person's answer: read_file is recorded, send_email
  // runs now.
  const first = { startedAt: 1, seed: 2, nonce: "the-first-run", tools: TOOLS.map((one) => [one.name, one.name]) };
  const calls = [];
  const nested = { call: async (name, args, key) => (calls.push([name, key]), name === "send_email" ? { text: "mailed", fresh: true } : { text: JSON.stringify({ body: "hello" }), fresh: false }), memo: async () => first };
  const answer = await python(codemodeOf(), 'a = await tools.read_file({})\nawait tools.send_email(body=f"{a[\'body\']}!")\nawait tools.write_file({})\nreturn "all done"', nested);
  assert.deepEqual(calls.map(([name]) => name), ["read_file", "send_email"], "the write after the parked call never ran");
  assert.deepEqual(calls.map(([, key]) => key), ["s0", "s1"], "each call under the key the first run gave it");
  assert.match(answer.text, /^The script was stopped/, answer.text);
  assert.deepEqual(answer.text.split("\n").filter((line) => /^\d+\. /.test(line)), [
    `1. read_file completed: {"body":"hello"}. Its effect is done; it was not run again.`,
    `2. send_email completed: "mailed". Its effect is done; it was not run again.`,
  ], answer.text);
  assert.doesNotMatch(answer.text, /all done/);
});

test("codemode's language is javascript or python: any other is refused before anything runs", async () => {
  const { calls, nested } = nestedCalls();
  const answer = await codemodeOf().call({ script: "await tools.read_file({})", language: "ruby" }, { signal: new AbortController().signal, nested });
  assert.equal(answer.isError, true);
  assert.match(answer.text, /language is javascript \(the default\) or python\. Nothing was run\./);
  assert.deepEqual(calls, []);
  assert.deepEqual(codemodeOf().inputSchema.properties.language.enum, ["javascript", "python"]);
});

/** A pi run of a Python codemode `script` over the suite's tools on a runner (its gate `gate(call)`, else the suite's: ask
 *  for `asked`), until the run is `settled`: what each suite tool ran, the server's store, and the provider's requests. */
async function pythonRun(t, script, { gate, settled = "ended" } = {}) {
  const opened = await stores({ runners: 1 });
  const { server, runners: [store] } = opened;
  await queue(server, "run-1");
  const { tools, ran } = suiteTools();
  const requests = [];
  const spec = piAdapterSpec({ script: [{ call: CODEMODE, args: { script, language: "python" } }, { say: "done" }], tools, hooks: quiet }, { requests });
  const loop = createAdapterLoop(async (claim, run) => ({ ...(await spec(claim, run)), ...(gate ? { gate } : {}) }));
  const runner = startRunner({ store, createLoop: loop, name: "runner-a", ...TIMING });
  t.after(async () => {
    try { await runner.close(); } finally { await release(opened); }
  });
  await ended(server, settled);
  return { ran, server, requests };
}

const ended = (server, state) => until(async () => {
  const now = await server.runs.get("run-1");
  return now.state === state && now.runner === null && now;
}, `the run ${state}`, 30_000);

/** The text of the newest tool result the provider got. */
function lastResult(requests) {
  const results = requests.flatMap((body) => (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : []))).filter((part) => part.type === "tool_result");
  const content = results.at(-1)?.content;
  return { text: typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""), isError: results.at(-1)?.is_error === true };
}

test("on a runner, a Python script's call of a tool set to deny ends the script in the gate's words: the call before it ran, none after it", async (t) => {
  const script = 'await tools.read({})\nawait tools.effect({})\nawait tools.read({})\nreturn "all done"';
  const { ran, requests } = await pythonRun(t, script, { gate: (call) => (call.tool === "effect" ? "deny" : "allow") });
  assert.deepEqual([ran.read, ran.effect], [1, 0], `read ran once, effect never: ${JSON.stringify(ran)}`);
  const said = lastResult(requests);
  assert.equal(said.isError, true);
  assert.ok(said.text.startsWith(deniedText("effect", undefined, "server", "no")), said.text);
  assert.match(said.text, /The script stopped at this refused call, and nothing after it ran\./);
  assert.match(said.text, /1\. read completed/);
  assert.doesNotMatch(said.text, /all done/);
});

test("on a runner, a Python script's ask parks the run; approved, the script runs again with its read answered from its record, the asked call runs once, and the effect after it never runs", async (t) => {
  const script = 'a = await tools.read({})\nb = await tools.asked({})\nawait tools.effect({})\nreturn [a, b]';
  const { ran, server, requests } = await pythonRun(t, script, { settled: "parked" });
  assert.deepEqual([ran.read, ran.asked, ran.effect], [1, 0, 0], "the read ran, and the asked call waits");
  const row = await server.runs.get("run-1");
  const { entries } = await journalRecords(server.journal({ runId: "run-1", runner: "test-reader", epoch: row.epoch, until: 0, from: row.state }), ctx);
  const ask = entries.find((entry) => entry.kind === KINDS.ask);
  assert.ok(ask, "the run wrote its ask");
  await sendCommand(server, "run-1", { kind: "approve", body: { approval: String(ask.data.callId) } });
  await ended(server, "ended");
  assert.deepEqual([ran.read, ran.asked, ran.effect], [1, 1, 0], "the read answered from its record, the asked call ran once, the effect never");
  const said = lastResult(requests).text;
  assert.match(said, /asked done/, said);
  assert.match(said, /The rest of the script did not run/, said);
});
