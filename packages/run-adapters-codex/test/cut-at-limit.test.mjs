// An answer the provider cut at its output limit (an OpenAI Responses stream whose data ends `response.incomplete` with
// `incomplete_details.reason: "max_output_tokens"`): the session's model proxy reads the stop before Codex has it, and the
// harness ends the turn at once, completed, its turn_end saying stopReason "length" with the output tokens, and the cut
// text kept. Codex's own handling (an incomplete stream is an error it retries, each time paid) never sends the request
// again: one upstream request, booked once. A content-filter stop stays filtered, never a cut. The stand-in app-server
// (fake-app-server.mjs) with its model the provider's, behind the real model proxy; the provider a fetch whose stream is
// data alone, as a gateway's is: no binary, no key, no network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';
import { cut } from '../dist/host/policy.js';

process.env.AGENTRUN_CODEX_STANDIN = '1';
const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-cut-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const FILTERED = 'content_filter: the model provider stopped this answer';
const usage = { input_tokens: 12, output_tokens: 7 };
const incomplete = (reason) => ({ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason }, usage } });

/** A Responses stream, its events as data alone (no `event:` lines): `text`, then its last event, `end`. */
const stream = (text, end) => [{ type: 'response.output_text.delta', item_id: 'm_0', output_index: 0, content_index: 0, delta: text }, end].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

async function turnOn(t, end) {
  const dir = mkdtempSync(join(ROOT, 'n-'));
  const sent = [];
  const booked = [];
  const fetch = async (input) => {
    sent.push(String(input instanceof Request ? input.url : input));
    return new Response(stream('The answer is', end), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const adapter = codexAdapter({ model: 'luna-test', provider: { origin: 'https://provider.invalid', credential: () => 'k' }, price: () => 0.001, sessionsDir: join(dir, 'sessions'), standIn: { command: process.execPath, args: [FAKE], env: { FAKE_CODEX_MODEL: 'responses' } }, fetch });
  const store = memorySessionStore();
  const events = [];
  const models = { beforeRequest: async () => ({ turn: 0 }), afterRequest: async (request) => void booked.push(request) };
  const session = await adapter.open({ key: 's1', label: 'root', system: [], tools: [], context: 'fresh' }, { writer: await store.open('s1'), models, signal: new AbortController().signal, onEvent: (event) => events.push(event) });
  t.after(() => session.close());
  await session.send('go');
  const outcome = await session.turnEnd();
  return { outcome, events, sent, booked, records: await store.read('s1') };
}

test('an answer cut at its output limit ends the turn at once: one request, booked once, stopReason "length", its text kept', { timeout: 60_000 }, async (t) => {
  const { outcome, events, sent, booked, records } = await turnOn(t, incomplete('max_output_tokens'));
  assert.equal(sent.length, 1, 'one upstream request: Codex never asked for the answer again');
  assert.equal(booked.length, 1, 'its cost booked once');
  assert.deepEqual(outcome, { status: 'completed' });
  assert.deepEqual(events.filter((event) => event.type === 'turn_end'), [{ type: 'turn_end', status: 'completed', stopReason: 'length', outputTokens: 7 }]);
  assert.equal(events.filter((event) => event.type === 'text').map((event) => event.delta).join(''), 'The answer is', 'the cut text, as it came');
  const json = JSON.stringify(records);
  assert.match(json, /"type":"message","role":"assistant","text":"The answer is"/, "the cut text in the session's records");
  assert.match(json, /"type":"turn","status":"completed","stopReason":"length","outputTokens":7/, "the turn's end in the session's records says it was cut");
});

test('a content-filter stop stays filtered: the turn fails in the filter words, never a cut', { timeout: 60_000 }, async (t) => {
  const { outcome, events, sent } = await turnOn(t, incomplete('content_filter'));
  assert.equal(sent.length, 1);
  assert.deepEqual(outcome, { status: 'failed', error: FILTERED });
  assert.equal(events.some((event) => event.stopReason !== undefined), false, 'no stop reason');
});

test("the session's next turn after a cut one asks the model again: the proxy admits its answer requests once the turn opens", { timeout: 60_000 }, async (t) => {
  const dir = mkdtempSync(join(ROOT, 'n-'));
  const sent = [];
  const ends = [incomplete('max_output_tokens'), { type: 'response.completed', response: { status: 'completed', usage } }];
  const fetch = async (input) => {
    sent.push(String(input instanceof Request ? input.url : input));
    return new Response(stream(sent.length === 1 ? 'The answer is' : 'All of it.', ends[Math.min(sent.length - 1, 1)]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const adapter = codexAdapter({ model: 'luna-test', provider: { origin: 'https://provider.invalid', credential: () => 'k' }, price: () => 0.001, sessionsDir: join(dir, 'sessions'), standIn: { command: process.execPath, args: [FAKE], env: { FAKE_CODEX_MODEL: 'responses' } }, fetch });
  const store = memorySessionStore();
  const events = [];
  const models = { beforeRequest: async () => ({ turn: 0 }), afterRequest: async () => {} };
  const session = await adapter.open({ key: 's1', label: 'root', system: [], tools: [], context: 'fresh' }, { writer: await store.open('s1'), models, signal: new AbortController().signal, onEvent: (event) => events.push(event) });
  t.after(() => session.close());
  await session.send('go');
  await session.turnEnd();
  await session.send('go on');
  assert.deepEqual(await session.turnEnd(), { status: 'completed' });
  assert.equal(sent.length, 2, 'one request for each turn');
  assert.deepEqual(events.filter((event) => event.type === 'turn_end'), [{ type: 'turn_end', status: 'completed', stopReason: 'length', outputTokens: 7 }, { type: 'turn_end', status: 'completed' }]);
});

test('a whole answer ends the turn as before: completed, no stop reason', { timeout: 60_000 }, async (t) => {
  const { outcome, events, sent } = await turnOn(t, { type: 'response.completed', response: { status: 'completed', usage } });
  assert.equal(sent.length, 1);
  assert.deepEqual(outcome, { status: 'completed' });
  assert.deepEqual(events.filter((event) => event.type === 'turn_end'), [{ type: 'turn_end', status: 'completed' }]);
});

test("the policy reads a cut from the data's own type and reason, never from an event line, and only for max_output_tokens", () => {
  const data = (event) => `data: ${JSON.stringify(event)}\n\n`;
  assert.deepEqual(cut(data(incomplete('max_output_tokens'))), { outputTokens: 7 });
  assert.equal(cut(data(incomplete('content_filter'))), undefined, 'a content-filter stop is no cut');
  assert.equal(cut(data({ type: 'response.completed', response: { status: 'completed', usage } })), undefined);
  // A kept line start (a stop line longer than the window): read by its data's type, an `event:` line naming it ignored.
  const start = `data: {"type":"response.incomplete","response":{"id":"r","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[`;
  assert.deepEqual(cut('', [start]), {});
  const unnamed = `data: {"response":{"id":"r","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[`;
  assert.equal(cut('', ['event: response.incomplete', unnamed]), undefined, 'an event line alone names no cut');
});
