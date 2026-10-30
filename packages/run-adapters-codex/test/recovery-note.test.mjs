// What Codex is told about a host tool's call that a crash cut off (harness.ts repairOutput): the call's replay policy
// as the run's log recorded it when the call started, through the kernel's tool bridge and drive, then this adapter's
// own text. No Codex binary: the log and the function that reads it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INTERRUPTED_TEXT, openDrive } from '@parcha/agentrun-adapters/kernel';
import { placeSubmissions, recoveryNote, toolBridge } from '@parcha/agentrun-adapters/process';
import { memorySessionStore } from '@parcha/agentrun-adapters/testing';
import { repairOutput } from '../dist/harness.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hang = () => new Promise(() => {});
/** A host tool as the adapter hands it to the kernel: a name, a schema and its replay policy. */
const tool = (name, replay, execute) => ({ name, description: name, inputSchema: { type: 'object' }, replay, execute });

/** A turn in which a `safe` host tool (c1) and a `never` one (c2) were each cut off mid-call, as the next drive reads it. */
async function cutOff() {
  const store = memorySessionStore();
  const first = await openDrive({ writer: await store.open('cut'), signal: new AbortController().signal });
  await first.submit({ id: 's1', kind: 'prompt', text: 'Look it up, then pay.' });
  await placeSubmissions(first, [first.pending()[0]]);
  const bridge = toolBridge(first, [tool('fetch_page', 'safe', hang), tool('pay', 'never', hang)], { live: false, serial: false });
  void bridge.call('fetch_page', {}, 'c1').catch(() => {});
  await pause(30);
  void bridge.call('pay', {}, 'c2').catch(() => {});
  await pause(30);
  // The process stops here; the next drive opens the same log.
  const next = await openDrive({ writer: await store.open('cut'), signal: new AbortController().signal });
  return next.state();
}

const call = (callId, name) => ({ callId, name, arguments: '{}', answered: false, line: 0 });

test("a host tool's call a crash cut off is told by its own replay policy: a safe one may be repeated, a never one may have taken effect", async () => {
  const state = await cutOff();
  assert.equal(state.effects.get('tool:c1')?.replay, 'safe', "the log recorded the safe tool's policy when its call started");
  assert.equal(state.effects.get('tool:c2')?.replay, 'never', "the log recorded the never tool's policy when its call started");
  // The output Codex gets for each call it has no output for.
  assert.equal(repairOutput(state, call('c1', 'fetch_page')), 'Interrupted before it reported a result. It is safe to repeat.');
  assert.equal(repairOutput(state, call('c2', 'pay')), INTERRUPTED_TEXT);
  assert.match(INTERRUPTED_TEXT, /may or may not have taken effect/);
});

test("a cut-off call's output says what the recovery note of the same turn says of it, never the opposite", async () => {
  // Both reach Codex on the same resume: the note as the turn's message, the output as the call's.
  const state = await cutOff();
  const told = Object.fromEntries(recoveryNote(state).calls.map((c) => [c.callId, c.status]));
  assert.deepEqual(told, { c1: 'retryable', c2: 'interrupted' });
  assert.match(repairOutput(state, call('c1', 'fetch_page')), /It is safe to repeat\./);
  assert.doesNotMatch(repairOutput(state, call('c2', 'pay')), /safe to repeat/);
});

test("a call still running in the drive that holds the session is never told it is safe to repeat, whatever its policy", async () => {
  // A call this drive started and has not finished: it may still be running, so even a safe one may have taken effect.
  const store = memorySessionStore();
  const drive = await openDrive({ writer: await store.open('live'), signal: new AbortController().signal });
  await drive.submit({ id: 's1', kind: 'prompt', text: 'Look it up.' });
  await placeSubmissions(drive, [drive.pending()[0]]);
  void toolBridge(drive, [tool('fetch_page', 'safe', hang)], { live: false }).call('fetch_page', {}, 'c3').catch(() => {});
  await pause(30);
  const state = drive.state();
  assert.deepEqual([state.effects.get('tool:c3')?.status, state.effects.get('tool:c3')?.replay], ['running', 'safe']);
  assert.equal(recoveryNote(state).calls.find((c) => c.callId === 'c3')?.status, 'running');
  assert.equal(repairOutput(state, call('c3', 'fetch_page')), 'Interrupted: the session stopped while this call ran. It may have taken effect: check before repeating it.');
});
