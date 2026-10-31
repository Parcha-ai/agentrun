// Which code-mode script a nested host-tool call belongs to: read from the rollout's lines and from the exec the model proxy's
// latest answer carried. Pure: no binary, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callKey, completedNested, execRecoveryOutput, NESTED_CALL, recoveryFacts, Scripts, settle, UNWATCHED } from '../dist/scripts.js';

const line = (payload) => JSON.stringify({ timestamp: '2026-10-29T23:00:00Z', type: 'response_item', payload });
const exec = (callId) => line({ type: 'custom_tool_call', name: 'exec', call_id: callId, input: 'await tools.slow({})' });
const execDone = (callId, text = 'Script completed\nWall time 0.1 seconds\nOutput:\n') => line({ type: 'custom_tool_call_output', call_id: callId, output: [{ type: 'input_text', text }] });
const execYielded = (callId, cell = '1') => line({ type: 'custom_tool_call_output', call_id: callId, output: `Script running with cell ID ${cell}\nWall time 0.1 seconds\nOutput:\n` });
const wait = (callId, cell = '1') => line({ type: 'function_call', name: 'wait', call_id: callId, arguments: JSON.stringify({ cell_id: cell, yield_time_ms: 5000 }) });
const waited = (callId, text) => line({ type: 'function_call_output', call_id: callId, output: [{ type: 'input_text', text }] });
/** A Scripts that has read `lines`, and which call ids are in the log. */
function read(...lines) {
  const scripts = new Scripts();
  const logged = new Set();
  for (const l of lines) {
    scripts.note(l);
    const p = JSON.parse(l).payload;
    if (/_call$/.test(p.type)) logged.add(p.call_id);
  }
  return { scripts, logged, tie: (announced) => scripts.tie(announced, (id) => logged.has(id)) };
}

test("a nested call's id is the one Codex gives a script's host tool call, and a model's call id is not", () => {
  assert.ok(NESTED_CALL.test('exec-0e41febd-a273-40e5-8b2a-44fb79a552ae'));
  for (const id of ['call_ZbDRvcBcuhSOo7QpT3R8LDV7', 'exec-1', 'exec-0e41febd-a273-40e5-8b2a-44fb79a552ae-x', '']) assert.ok(!NESTED_CALL.test(id), id);
});

test("with one exec in the log, a nested call is tied to it; with none known, it waits for one", () => {
  assert.deepEqual(read().tie(undefined), { kind: 'none' });
  assert.deepEqual(read(exec('call_a')).tie(undefined), { kind: 'tied', exec: 'call_a' });
  // The proxy has seen the exec before its line is in the log: the call waits for the line, and is then tied.
  assert.deepEqual(read().tie('call_a'), { kind: 'held', exec: 'call_a' });
  const { scripts, logged } = read();
  assert.deepEqual(scripts.tie('call_a', (id) => logged.has(id)), { kind: 'held', exec: 'call_a' });
  scripts.note(exec('call_a'));
  logged.add('call_a');
  assert.deepEqual(scripts.tie('call_a', (id) => logged.has(id)), { kind: 'tied', exec: 'call_a' });
});

test("a finished exec is not live: the next exec's nested call is held until that exec's own line is in the log", () => {
  // exec A ran and has its output; the model wrote exec B, which the proxy saw, but B's line is not in the log yet.
  const { scripts, logged } = read(exec('call_a'), execDone('call_a'));
  assert.deepEqual(scripts.tie('call_b', (id) => logged.has(id)), { kind: 'held', exec: 'call_b' }, 'not tied to A');
  scripts.note(exec('call_b'));
  logged.add('call_b');
  assert.deepEqual(scripts.tie('call_b', (id) => logged.has(id)), { kind: 'tied', exec: 'call_b' });
  // And with the answer's announcement gone (the latest answer held no exec) and B finished, nothing is live.
  scripts.note(execDone('call_b'));
  assert.deepEqual(scripts.tie(undefined, (id) => logged.has(id)), { kind: 'none' });
  assert.deepEqual(scripts.tie('call_b', (id) => logged.has(id)), { kind: 'none' }, 'an exec that finished is not live again when it is still the latest announced');
});

test("a script that yielded stays live until the wait that finishes its cell; its nested call after the wait is tied to it", () => {
  const yielded = read(exec('call_a'), execYielded('call_a'));
  assert.deepEqual(yielded.tie(undefined), { kind: 'tied', exec: 'call_a' }, 'running after its exec had an output');
  const resumed = read(exec('call_a'), execYielded('call_a'), wait('call_w'));
  assert.deepEqual(resumed.tie(undefined), { kind: 'tied', exec: 'call_a' });
  const stillRunning = read(exec('call_a'), execYielded('call_a'), wait('call_w'), waited('call_w', 'Script running with cell ID 1\nWall time 5 seconds'));
  assert.deepEqual(stillRunning.tie(undefined), { kind: 'tied', exec: 'call_a' }, 'a wait that says it still runs does not end it');
  const ended = read(exec('call_a'), execYielded('call_a'), wait('call_w'), waited('call_w', 'Script completed\nWall time 1.8 seconds\nOutput:\n'));
  assert.deepEqual(ended.tie(undefined), { kind: 'none' });
  const gone = read(exec('call_a'), execYielded('call_a'), wait('call_w'), waited('call_w', 'Script failed\nScript error:\nexec cell 1 not found'));
  assert.deepEqual(gone.tie(undefined), { kind: 'none' });
  // A wait on another cell does not end this one.
  const other = read(exec('call_a'), execYielded('call_a', '1'), wait('call_w', '2'), waited('call_w', 'Script completed'));
  assert.deepEqual(other.tie(undefined), { kind: 'tied', exec: 'call_a' });
});

test("two scripts live at once (a cell still running, and a new exec the model wrote): a nested call is ambiguous until one finishes", () => {
  const { scripts, logged } = read(exec('call_a'), execYielded('call_a'));
  // The model wrote exec B anyway; the proxy saw it, and its line is not in the log yet.
  assert.deepEqual(scripts.tie('call_b', (id) => logged.has(id)), { kind: 'ambiguous', live: ['call_a', 'call_b'] });
  // Its line lands: still two.
  scripts.note(exec('call_b'));
  logged.add('call_b');
  assert.equal(scripts.tie('call_b', (id) => logged.has(id)).kind, 'ambiguous');
  // A finishes (the wait says so): B alone.
  scripts.note(wait('call_w'));
  scripts.note(waited('call_w', 'Script completed\nWall time 1.8 seconds'));
  assert.deepEqual(scripts.tie('call_b', (id) => logged.has(id)), { kind: 'tied', exec: 'call_b' });
});

test("an answer the proxy could not watch to its end counts as a script of its own, never in the log: a nested call is held, or ambiguous, and never falls back to the exec before", () => {
  const { scripts, logged } = read(exec('call_a'), execDone('call_a'), exec('call_b'));
  // B is open and its line is durable; the answer after it was lost.
  assert.deepEqual(scripts.tie(UNWATCHED, (id) => logged.has(id)), { kind: 'ambiguous', live: ['call_b', UNWATCHED] });
  const alone = read(exec('call_a'), execDone('call_a'));
  assert.deepEqual(alone.tie(UNWATCHED), { kind: 'held', exec: UNWATCHED }, 'held for a line that never comes');
  // The next answer is watched cleanly (nothing announced): the lost one no longer counts.
  assert.deepEqual(alone.tie(undefined), { kind: 'none' });
});

const nested = (callId, tool, store, rollout) => ({ callId, tool, ...(store ? { store } : {}), ...(rollout ? { rollout } : {}) });
const done = (text) => ({ status: 'completed', text });
const rolled = (text, ok = true) => ({ tool: 'x', ok, text });

test("a nested call comes to what the store says, then what the rollout says; they must agree, or it is interrupted", () => {
  assert.deepEqual(settle(nested('e1', 'record', done('recorded'))), { kind: 'completed', text: 'recorded' }, 'store only');
  assert.deepEqual(settle(nested('e1', 'record', undefined, rolled('recorded'))), { kind: 'completed', text: 'recorded' }, 'rollout only (the store lost the end)');
  assert.deepEqual(settle(nested('e1', 'record', { status: 'started' }, rolled('recorded'))), { kind: 'completed', text: 'recorded' }, 'store started, rollout completed: Codex writes that line only after our tool answered, so the effect happened');
  assert.deepEqual(settle(nested('e1', 'record', done('recorded'), rolled('recorded'))), { kind: 'completed', text: 'recorded' }, 'both, agreeing');
  assert.deepEqual(settle(nested('e1', 'record', done('recorded'), rolled('something else'))), { kind: 'interrupted' }, 'both, disagreeing');
  assert.deepEqual(settle(nested('e1', 'record', { status: 'started' })), { kind: 'interrupted' }, 'started, no end');
  assert.deepEqual(settle(nested('e1', 'record', { status: 'failed', text: 'cut', interrupted: true })), { kind: 'interrupted' });
  assert.deepEqual(settle(nested('e1', 'record', { status: 'failed', text: 'bad input' })), { kind: 'failed', text: 'bad input' });
  assert.deepEqual(settle(nested('e1', 'record', undefined, rolled('nope', false))), { kind: 'failed', text: 'nope' });
});

test("the answer to a cut-off exec lists its nested calls in order with their outcomes, says nothing was run again, and says 'not executed' of no call that completed", () => {
  const text = execRecoveryOutput([nested('e1', 'record', done('recorded')), nested('e2', 'record', done('recorded twice')), nested('e3', 'lookup', { status: 'started' })]);
  assert.match(text, /cut short after these calls/);
  const at = (needle) => text.indexOf(needle);
  assert.ok(at('1. record completed: "recorded"') >= 0 && at('1. record completed: "recorded"') < at('2. record completed: "recorded twice"') && at('2. record completed') < at('3. lookup was started'), 'in order, each its own outcome (two identical calls too)');
  assert.match(text, /effect is done/);
  assert.match(text, /nothing was run again/);
  assert.ok(!/not executed/i.test(text));
  assert.match(execRecoveryOutput([]), /ran none/);
});

test("a call is matched on its tool and its arguments, whatever the order of the arguments' keys", () => {
  assert.equal(callKey('record', { answer: 'Paris', n: 1 }), callKey('record', { n: 1, answer: 'Paris' }));
  assert.notEqual(callKey('record', { answer: 'Paris' }), callKey('record', { answer: 'Rome' }));
  assert.notEqual(callKey('record', { answer: 'Paris' }), callKey('lookup', { answer: 'Paris' }));
});

test("the rollout's completion of a nested call is read from its item_completed line, and only a completed or failed one", () => {
  const item = (status) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'DynamicToolCall', id: 'exec-0e41febd-a273-40e5-8b2a-44fb79a552ae', tool: 'record', status, success: status === 'completed', content_items: [{ type: 'inputText', text: 'recorded' }] } } });
  assert.deepEqual([...completedNested([item('completed')])], [['exec-0e41febd-a273-40e5-8b2a-44fb79a552ae', { tool: 'record', ok: true, text: 'recorded' }]]);
  assert.equal(completedNested([item('inProgress')]).size, 0);
  assert.equal(completedNested(['not json', JSON.stringify({ type: 'response_item', payload: { type: 'message' } })]).size, 0);
});

test("two cut-off execs and an unwatched safe call of the turn: the call is listed once, apart, in the last exec's output, under neither exec's own list, and a call of another turn is not", () => {
  const ties = [
    { callId: 'exec-a1', exec: 'call_a', since: 3 },
    { callId: 'exec-b1', exec: 'call_b', since: 3 },
    { callId: 'exec-u1', exec: null, since: 3 },
    { callId: 'exec-old', exec: null, since: 1 },
  ];
  const fact = (tie) => ({ callId: tie.callId, tool: tie.callId.replace('exec-', 'tool-'), store: { status: 'completed', text: `out ${tie.callId}` } });
  const listed = recoveryFacts(['call_a', 'call_b'], ties, 3, fact);
  assert.deepEqual(listed.get('call_a').own.map((f) => f.callId), ['exec-a1']);
  assert.deepEqual(listed.get('call_a').loose, [], 'not the first exec\'s');
  assert.deepEqual(listed.get('call_b').loose.map((f) => f.callId), ['exec-u1'], 'the last exec\'s, and only this turn\'s');
  const outputs = ['call_a', 'call_b'].map((id) => execRecoveryOutput(listed.get(id).own, listed.get(id).loose));
  assert.ok(!/could not be told/.test(outputs[0]));
  assert.match(outputs[1], /1 call ran whose script could not be told/);
  assert.equal(outputs.join('\n').split('tool-u1 completed').length - 1, 1, 'listed exactly once');
  assert.ok(!outputs.join('\n').includes('tool-old'), 'a call of another turn is not listed');
  const own = outputs[1].split('1 call ran whose script')[0];
  assert.ok(!own.includes('tool-u1'), 'under neither exec\'s own list');
});

test("no slot of the model's takes the full recovery note: the harness never falls back to the note's text, which holds tool outputs", async () => {
  // recoverySystemNote cannot be stubbed in an ES module, so this reads what the built modules do with it: code-mode.js injects only what
  // recoverySystemNote returned, and nothing when that is undefined; and the harness replaces the old user text (which began as the full
  // note) with the user's own words before anything is sent.
  const { readFileSync } = await import('node:fs');
  const built = readFileSync(new URL('../dist/code-mode.js', import.meta.url), 'utf8');
  assert.ok(!/\bnote\.text\b/.test(built), 'note.text (the full note) is not used by the module');
  assert.match(built, /system !== undefined && !noted/, 'no developer item is injected without a system note');
  assert.ok(!/recoverySystemNote\(ctx\.state\(\)\)\s*\?\?/.test(built), 'no fallback after recoverySystemNote');
  const harness = readFileSync(new URL('../dist/harness.js', import.meta.url), 'utf8');
  const replaced = harness.indexOf('text = await code.resumeTurn(note, owed);');
  assert.ok(replaced > 0, 'the user text is replaced by the user\'s own words');
  assert.ok(replaced < harness.indexOf("synthetic: 'recovery'"), 'before it is journaled or sent');
});

test("a cut-off exec with no call of its own but unattributed ones does not say it ran none; with no calls at all it does", () => {
  const call = { callId: 'exec-u1', tool: 'lookup', store: { status: 'completed', text: 'found' } };
  const withLoose = execRecoveryOutput([], [call]);
  assert.match(withLoose, /no call of its own was recorded/);
  assert.match(withLoose, /1 call ran whose script could not be told/);
  assert.ok(!/ran none/.test(withLoose) && !/Run it again/.test(withLoose), 'it does not tell the model to run the script again');
  const none = execRecoveryOutput([], []);
  assert.match(none, /ran none\. Run it again if it is still needed\./);
  assert.ok(!/could not be told/.test(none));
});

test("a finished script that prints the running phrase is still finished: only Codex's status header says a cell runs", () => {
  const printed = 'Script running with cell ID 7';
  // Its exec's output: Codex's header says it completed; the script's own text follows.
  const done = line({ type: 'custom_tool_call_output', call_id: 'call_a', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: printed }] });
  assert.deepEqual(read(exec('call_a'), done).tie(undefined), { kind: 'none' }, 'a list output');
  const doneText = line({ type: 'custom_tool_call_output', call_id: 'call_a', output: `Script completed\nWall time 0.1 seconds\nOutput:\n${printed}` });
  assert.deepEqual(read(exec('call_a'), doneText).tie(undefined), { kind: 'none' }, 'a text output');
  // A wait that finished a cell, whose script printed the phrase, finishes it too.
  const ended = read(exec('call_a'), execYielded('call_a'), wait('call_w'), line({ type: 'function_call_output', call_id: 'call_w', output: [{ type: 'input_text', text: 'Script completed\nWall time 1 seconds\nOutput:\n' }, { type: 'input_text', text: printed.replace('7', '1') }] }));
  assert.deepEqual(ended.tie(undefined), { kind: 'none' });
});
