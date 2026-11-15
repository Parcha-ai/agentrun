// A code-mode script that ran a call to its end beside one the host's gate parked (a person's approval), cut when the run
// parked, then resumed once the person answered (code-mode.ts recoverItems and resumeTurn, scripts.ts execRecoveryOutput):
// the cut exec's output hands the model each finished call's result as the bridge handed it live (the host's bound,
// `boundResult`), never a shorter cut, and the recovery note says that result is there instead of "not shown here". So the
// model has no reason to run the finished call again. No Codex binary: the log, the ties of the nested calls to their exec,
// and the hooks that build the outputs and the note.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOST_RESULT_MAX_CHARS } from '@parcha/agentrun-kernel';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { openTurn, placeSubmissions, toolBridge } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codeMode, NESTED_STREAM } from '../dist/code-mode.js';
import { kernelTool } from '../dist/adapter.js';

const EXEC = 'call_exec_1';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DENIED = 'Denied: no issue for this check.';

/** One exec whose script ran `siblings` (each `{ id, name, answer: { text, isError? } | 'hang' }`, its call through the bridge
 *  under `exec-<n>`, run to its end or left hanging when the process stops) and then a write the gate parked (`exec-w`).
 *  The process stops; the next drive resumes the turn with the person's deny on the write: the exec's recovered output, the
 *  recovery note the turn is resumed with, and what each tool's live call was handed (`live`). */
async function cutBesidePark(siblings) {
  const store = memorySessionStore();
  const first = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  await first.submit({ id: 's1', kind: 'prompt', text: 'List them and file one.' });
  await placeSubmissions(first, [first.pending()[0]]);
  const since = openTurn(first.state()).since;
  const hosts = siblings.map(({ name, answer }) => ({ name: `mcp__fake__${name}`, description: name, inputSchema: { type: 'object' }, replay: 'never', call: answer === 'hang' ? () => new Promise(() => {}) : async () => answer }));
  const write = { name: 'mcp__fake__file', description: 'Files one.', inputSchema: { type: 'object' }, replay: 'never', call: async () => ({ text: 'filed #10' }) };
  const gate = async (call) => (call.tool === 'mcp_fake__file' ? { ask: true } : 'allow');
  const bridge = toolBridge(first, [...hosts, write].map(kernelTool), { live: false, serial: false, gate });
  const live = {};
  for (const { id, name, answer } of siblings) {
    const called = bridge.call(`mcp_fake__${name}`, {}, id);
    if (answer === 'hang') void called.catch(() => {});
    else live[id] = await called;
  }
  await pause(20);
  const parked = new AbortController();
  const held = bridge.call('mcp_fake__file', { title: 'x' }, 'exec-w', parked.signal);
  await pause(20);
  parked.abort();
  await assert.rejects(held, /was parked/);
  const ties = [...siblings.map(({ id, name }) => ({ callId: id, exec: EXEC, since, tool: `mcp_fake__${name}`, args: {} })), { callId: 'exec-w', exec: EXEC, since, tool: 'mcp_fake__file', args: { title: 'x' } }];
  // The process stops here; the next drive opens the same log, with the person's deny on the write.
  const next = await openDrive({ writer: await store.open('code'), signal: new AbortController().signal });
  const kept = [];
  const journal = { append: (stream, data) => kept.push([stream, data]), flush: async () => {}, read: async (stream) => [...(stream === NESTED_STREAM ? ties : []), ...kept.filter(([s]) => s === stream).map(([, data]) => data)].map((data) => ({ data })) };
  const resumed = toolBridge(next, [...hosts, write].map(kernelTool), { live: false, serial: false, gate: async (call) => (call.tool === 'mcp_fake__file' ? { deny: DENIED } : 'allow') });
  const injected = [];
  const mode = codeMode({ ctx: next, machine: {}, journal, logged: new Set(), synced: async () => {}, bridge: resumed, log() {}, lines: [], rpc: () => ({ request: async (_method, params) => void injected.push(...params.items) }), guard: (p) => p, threadId: () => 't', tries: 1 });
  const items = [{ type: 'custom_tool_call_output', call_id: EXEC, output: '' }];
  await mode.recoverItems(items, [{ callId: EXEC, name: 'exec', type: 'custom_tool_call' }], [], since, true);
  await mode.resumeTurn({ turn: { since }, pending: [] }, []);
  const note = injected.find((item) => item.role === 'developer')?.content?.[0]?.text ?? '';
  return { output: items[0].output, note, live };
}

/** The outcome line the exec's output gives call `n` (1-based), with the text it quotes read back (`quoted`). */
function told(output, n) {
  const at = output.indexOf(`\n${n}. `);
  assert.ok(at >= 0, `call ${n} is told: ${output.slice(0, 300)}`);
  const rest = output.slice(at + 1);
  const next = rest.search(/\n\d+\. mcp_fake__/);
  const line = next < 0 ? rest : rest.slice(0, next);
  const open = line.indexOf('"');
  let quoted;
  if (open >= 0) {
    // The quoted text is JSON: read it back with the parser, to its closing quote.
    for (let end = line.lastIndexOf('"'); end > open && quoted === undefined; end = line.lastIndexOf('"', end - 1)) {
      try {
        quoted = JSON.parse(line.slice(open, end + 1));
      } catch {}
    }
  }
  return { line, quoted };
}

test("a finished read beside the parked write, its result past 2,000 characters, is handed back whole, as the bridge handed it live", async () => {
  const list = `[{"number":9,"title":"one"}${',{"number":8,"title":"two"}'.repeat(300)}]`;
  assert.ok(list.length > 2_000 && list.length < HOST_RESULT_MAX_CHARS);
  const { output, live } = await cutBesidePark([{ id: 'exec-1', name: 'list', answer: { text: list } }]);
  const read = told(output, 1);
  assert.match(read.line, /^1\. mcp_fake__list completed: /);
  assert.doesNotMatch(read.line, /more characters\]/, 'not cut short');
  assert.equal(read.quoted, live['exec-1'].text, 'the text the script was handed live, word for word');
  assert.equal(read.quoted, list);
  assert.match(told(output, 2).line, /^2\. mcp_fake__file waited for a person's approval, then: "Denied: no issue for this check\."\. It did not run\./);
});

test("the recovery note says the finished read's result is in the script's output, and never that it is not shown", async () => {
  const list = 'n'.repeat(5_000);
  const { note } = await cutBesidePark([{ id: 'exec-1', name: 'list', answer: { text: list } }]);
  assert.match(note, /- mcp_fake__list, call exec-1: completed\. Its result is in the output of the script that made the call, above\./);
  assert.doesNotMatch(note, /not shown here/, note);
});

test("a read past the host's bound is handed back as the bridge held it live: its start, and the line that says where it was cut", async () => {
  const long = `start ${'y'.repeat(HOST_RESULT_MAX_CHARS + 5_000)}`;
  const { output, live } = await cutBesidePark([{ id: 'exec-1', name: 'list', answer: { text: long } }]);
  assert.match(live['exec-1'].text, /\n\[cut at \d+ of \d+ characters\]$/, 'live, the bridge held it to its bound');
  const read = told(output, 1);
  assert.equal(read.quoted, live['exec-1'].text, 'the same text as live');
  assert.match(told(output, 2).line, /then: "Denied: no issue for this check\."/, "the write's outcome is still told after it");
  assert.ok(output.length <= HOST_RESULT_MAX_CHARS + 2_000, `the whole output stays near one result's bound: ${output.length}`);
});

test("a failed call beside the parked write carries its error as the bridge handed it live, and the note says so", async () => {
  const error = `GitHub said no: ${'e'.repeat(3_000)}`;
  const { output, note, live } = await cutBesidePark([{ id: 'exec-1', name: 'list', answer: { text: error, isError: true } }]);
  assert.equal(live['exec-1'].isError, true);
  const read = told(output, 1);
  assert.match(read.line, /^1\. mcp_fake__list failed: /);
  assert.equal(read.quoted, live['exec-1'].text, 'its error, word for word');
  assert.match(note, /- mcp_fake__list, call exec-1: failed\. Its error is in the output of the script that made the call, above\./);
  assert.doesNotMatch(note, /not shown here/);
});

test("a script with a call cut mid-way beside the parked one: the cut call is told as before, and the note keeps today's words for it", async () => {
  const { output, note } = await cutBesidePark([{ id: 'exec-1', name: 'list', answer: { text: 'k'.repeat(4_000) } }, { id: 'exec-2', name: 'pay', answer: 'hang' }]);
  assert.equal(told(output, 1).quoted, 'k'.repeat(4_000));
  assert.match(told(output, 2).line, /^2\. mcp_fake__pay was started and did not report a result, so it may have taken effect: check before calling it again\. It was not run again\./);
  assert.match(told(output, 3).line, /^3\. mcp_fake__file waited for a person's approval, then: /);
  assert.match(note, /- mcp_fake__list, call exec-1: completed\. Its result is in the output of the script that made the call, above\./);
  assert.match(note, /- mcp_fake__pay, call exec-2: interrupted before it reported a result\. It is not safe to repeat, and it may have taken effect\./);
  assert.match(note, /\n\nThe output of the other calls is not shown here\. Check the actual state before relying on it\./, note);
});

test("finished results past one result's bound (and the words around it) together are each cut to fit, each saying where and keeping its last line, and every call's outcome is still told", async () => {
  const each = Math.ceil(HOST_RESULT_MAX_CHARS * 0.6);
  // A filed answer's last line says where the whole is (serve's filed-answer.ts): a cut keeps it.
  const answer = (n) => ({ text: `${String(n).repeat(each)}\n[cut at line 4 of 9; the whole answer is in the run's files at evidence/mcp/fake/r${n}.txt: read it with offset=5 to go on]` });
  const { output } = await cutBesidePark([{ id: 'exec-1', name: 'list', answer: answer(1) }, { id: 'exec-2', name: 'page', answer: answer(2) }]);
  assert.ok(output.length <= HOST_RESULT_MAX_CHARS + 2_000, `within one result's bound and the words around it: ${output.length}`);
  for (const n of [1, 2]) {
    const { quoted } = told(output, n);
    assert.ok(quoted.startsWith(String(n).repeat(100)), `call ${n} keeps its start`);
    assert.match(quoted, new RegExp(`\\n\\[cut at \\d+ of ${answer(n).text.length} characters\\]\\n\\[cut at line 4 of 9; the whole answer is in the run's files at evidence/mcp/fake/r${n}\\.txt: read it with offset=5 to go on\\]$`), `call ${n} says where it was cut, its last line kept`);
  }
  assert.match(told(output, 3).line, /^3\. mcp_fake__file waited for a person's approval, then: "Denied: no issue for this check\."\. It did not run\./);
});

test("a script whose calls' lines alone pass the bound: the note says a result is above only for the calls the cut output still tells, and \"not shown\" for the rest", async () => {
  // 2,000 short reads beside the parked write: even their outcome lines, results cut to nothing, pass the bound, so the
  // output itself is cut and the later calls are not in it.
  // Each a tool of its own (the bridge holds one tool per name), so each answer is its own.
  const siblings = Array.from({ length: 2_000 }, (_, i) => ({ id: `exec-${i + 1}`, name: `list${i + 1}`, answer: { text: `r${i + 1}` } }));
  const { output, note } = await cutBesidePark(siblings);
  assert.ok(output.length <= HOST_RESULT_MAX_CHARS + 2_000, `held to the bound: ${output.length}`);
  const inOutput = (n) => output.includes(`\n${n}. mcp_fake__list${n} completed: "r${n}". Its effect is done; it was not run again.\n`);
  assert.ok(inOutput(1), 'the first call is told');
  assert.ok(!inOutput(2_000), 'the last call is cut from the output');
  let above = 0;
  for (let n = 1; n <= 2_000; n++) {
    const said = note.includes(`- mcp_fake__list${n}, call exec-${n}: completed. Its result is in the output of the script that made the call, above.\n`);
    assert.equal(said, inOutput(n), `call ${n}: the note says its result is above only when the output holds it (${inOutput(n) ? 'held' : 'cut'})`);
    if (said) above++;
  }
  assert.ok(above > 0 && above < 2_000, `some above, some not: ${above}`);
  assert.match(note, /- mcp_fake__list2000, call exec-2000: completed\.\n/, 'a cut call keeps the plain words');
  assert.match(note, /\n\nThe output of the other calls is not shown here\. Check the actual state before relying on it\./);
});
