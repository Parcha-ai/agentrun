// A script's read (a call a code-mode script made: outsideTurn, or nested in a tool's call) is cut to the model's window
// share like any result, but a script computes on it: a cut JSON read hands the script half a document whose parse fails
// on a character in the middle ("Bad control character ... at position 13"), and the model never learns the read was cut.
// So a JSON read too large for the window is handed as a note alone, which a parse fails on legibly
// (`Unexpected token 'r', "[read cut:"... is not valid JSON`) and a script that prints it shows the model. Text that is
// not JSON keeps its start and the cut's note, as before: a script can still use it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import { toolBridge } from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

const WINDOW = 16_384;
const JSON_READ = JSON.stringify({ rows: Array.from({ length: 2_000 }, (_, i) => ({ id: i, name: `row ${i}` })) });
const TEXT_READ = `START ${'line of a log\n'.repeat(3_000)}`;
const reader = (text) => ({ name: 'read', description: 'Reads.', inputSchema: { type: 'object' }, replay: 'safe', execute: async () => text });
const drive = async (key) => openDrive({ writer: await memorySessionStore().open(key), signal: new AbortController().signal });

/** What JSON.parse says of `text`: its value, or its error's message. */
const parsed = (text) => {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return { error: error.message };
  }
};

test("a script's JSON read past its window share: the script gets the cut's note alone, and its parse says the read was cut", async () => {
  // MUTATION: a script's read cut like the model's hands half a JSON document: its parse fails mid-string, saying nothing of the cut.
  const bridge = toolBridge(await drive('j'), [reader(JSON_READ)], { budget: { contextWindow: WINDOW }, outsideTurn: () => true });
  const result = await bridge.call('read', {}, 'exec-1');
  assert.equal(result.truncated, true);
  assert.match(result.text, /^\[read cut: /, `the note alone: ${result.text.slice(0, 120)}`);
  assert.match(result.text, new RegExp(`${JSON_READ.length} characters`), 'it says how long the read was');
  assert.ok(!result.text.includes('"rows"'), 'none of the document');
  const { error } = parsed(result.text);
  assert.match(error ?? '', /"\[read cut:/, `the parse names the cut: ${error}`);
});

test("a script's read that is not JSON keeps its start and the cut's note, as before", async () => {
  const bridge = toolBridge(await drive('t'), [reader(TEXT_READ)], { budget: { contextWindow: WINDOW }, outsideTurn: () => true });
  const result = await bridge.call('read', {}, 'exec-2');
  assert.equal(result.truncated, true);
  assert.match(result.text, /^START line of a log/);
  assert.match(result.text, /\[kept \d+ of \d+ characters/);
});

test("the model's own JSON read keeps its start and the cut's note: the model reads it, it computes on nothing", async () => {
  const bridge = toolBridge(await drive('m'), [reader(JSON_READ)], { budget: { contextWindow: WINDOW } });
  const result = await bridge.call('read', {}, 'call-1');
  assert.equal(result.truncated, true);
  assert.match(result.text, /^\{"rows":/);
  assert.match(result.text, /\[kept \d+ of \d+ characters/);
});

test("a script's JSON read replayed from its record is handed the same note", async () => {
  const store = memorySessionStore();
  const first = await openDrive({ writer: await store.open('r'), signal: new AbortController().signal });
  const once = await toolBridge(first, [reader(JSON_READ)], { budget: { contextWindow: WINDOW }, outsideTurn: () => true }).call('read', {}, 'exec-3');
  const next = await openDrive({ writer: await store.open('r'), signal: new AbortController().signal });
  const again = await toolBridge(next, [reader(JSON_READ)], { budget: { contextWindow: WINDOW }, outsideTurn: () => true }).call('read', {}, 'exec-3');
  assert.equal(again.text, once.text);
});
