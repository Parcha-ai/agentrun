// A provider that stops an answer on its content filter (an OpenAI Responses stream that ends `response.incomplete` with
// `incomplete_details.reason: "content_filter"`): the session's model proxy reads the stop in the answer it passes and the
// harness ends the turn at once, failed with the kernel's content-filter text, so Codex's own handling (it retries an
// incomplete stream) never sends the refused request again. The stand-in app-server (fake-app-server.mjs) behind the real
// model proxy, the provider a fetch: no binary, no key, no network.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarnessRunner, HarnessRunError } from '@parcha/agentrun-kernel';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { codexAdapter } from '@parcha/agentrun-harness-codex';
import { filtered } from '../dist/host/policy.js';

process.env.AGENTRUN_CODEX_STANDIN = '1';
const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-filter-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
/** The text a turn the provider's content filter stopped ends with (the kernel's CONTENT_FILTERED). */
const FILTERED = 'content_filter: the model provider stopped this answer';
const SCHEMA = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };
const request = { kind: 'agent', label: 'filtered', system: [], user: 'What is 2 plus 2?', schema: SCHEMA, tools: [] };

/** A Responses stream: `text` (in pieces of at most 4 KiB), then its last event, `end`. Each event is named on its own
 *  line, as OpenAI's API names it, or, `named` false, sent as its data alone, as a LiteLLM gateway sends it. */
const stream = (text, end, named = true) => {
  const pieces = text ? text.match(/[\s\S]{1,4096}/g) : [''];
  return `${[...pieces.map((delta) => ({ delta, type: 'response.output_text.delta' })), { delta: '', ...end }].map((e) => `${named ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
};
const usage = { input_tokens: 12, output_tokens: 0 };

function adapterOn(end, sent, text = '', named = true) {
  const dir = mkdtempSync(join(ROOT, 'n-'));
  const fetch = async (input) => {
    sent.push(String(input instanceof Request ? input.url : input));
    return new Response(stream(text, end, named), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return codexAdapter({ model: 'luna-test', provider: { origin: 'https://provider.invalid', credential: () => 'k' }, sessionsDir: join(dir, 'sessions'), standIn: { command: process.execPath, args: [FAKE], env: { FAKE_CODEX_MODEL: 'remote' } }, fetch });
}

test('a provider that stops the answer on its content filter (response.incomplete, reason content_filter) ends the turn at once: failed with the content-filter text, after one request', { timeout: 60_000 }, async () => {
  const sent = [];
  const end = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, usage } };
  const node = createHarnessRunner(adapterOn(end, sent), { store: memorySessionStore(), tools: [], maxTurns: 3 });
  const outcome = await node(request).then((record) => ({ delivered: record }), (error) => error);
  assert.ok(outcome instanceof HarnessRunError, `the node delivered nothing: ${JSON.stringify(outcome)}`);
  assert.deepEqual([outcome.reason, outcome.message], ['model_error', FILTERED], 'the turn failed with the content-filter text');
  assert.equal(sent.filter((url) => url.endsWith('/responses')).length, 1, 'one request: the refused answer is never asked for again');
});

test('a long answer whose final event is longer than the model proxy keeps of it (encrypted reasoning past 64 KiB), the stop early in it: the turn still ends at once, after one request', { timeout: 60_000 }, async () => {
  // The answer's text runs past the first 64 KiB the proxy keeps, and the final event's own line past the last 64 KiB:
  // neither window holds the start of the event that says the provider's content filter stopped it.
  const sent = [];
  const end = { type: 'response.incomplete', response: { id: 'resp_1', object: 'response', status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'e'.repeat(100 * 1024) }], usage } };
  const node = createHarnessRunner(adapterOn(end, sent, 'w'.repeat(70 * 1024)), { store: memorySessionStore(), tools: [], maxTurns: 3 });
  const outcome = await node(request).then((record) => ({ delivered: record }), (error) => error);
  assert.ok(outcome instanceof HarnessRunError, `the node delivered nothing: ${JSON.stringify(outcome)}`);
  assert.deepEqual([outcome.reason, outcome.message], ['model_error', FILTERED], 'the long answer\'s turn failed with the content-filter text');
  assert.equal(sent.filter((url) => url.endsWith('/responses')).length, 1, 'one request: the refused answer is never asked for again');
});

test('the same long answer through a gateway that sends each event as its data alone (no event: lines, as LiteLLM does): the turn still ends at once, after one request', { timeout: 60_000 }, async () => {
  const sent = [];
  const end = { type: 'response.incomplete', response: { id: 'resp_1', object: 'response', status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'e'.repeat(100 * 1024) }], usage } };
  const node = createHarnessRunner(adapterOn(end, sent, 'w'.repeat(70 * 1024), false), { store: memorySessionStore(), tools: [], maxTurns: 3 });
  const outcome = await node(request).then((record) => ({ delivered: record }), (error) => error);
  assert.ok(outcome instanceof HarnessRunError, `the node delivered nothing: ${JSON.stringify(outcome)}`);
  assert.deepEqual([outcome.reason, outcome.message], ['model_error', FILTERED], 'the data-only long answer\'s turn failed with the content-filter text');
  assert.equal(sent.filter((url) => url.endsWith('/responses')).length, 1, 'one request: the refused answer is never asked for again');
});

test('a short answer the provider stops on its content filter, through a gateway that sends each event as its data alone: the turn ends at once, after one request', { timeout: 60_000 }, async () => {
  const sent = [];
  const end = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, usage } };
  const node = createHarnessRunner(adapterOn(end, sent, '', false), { store: memorySessionStore(), tools: [], maxTurns: 3 });
  const outcome = await node(request).then((record) => ({ delivered: record }), (error) => error);
  assert.ok(outcome instanceof HarnessRunError, `the node delivered nothing: ${JSON.stringify(outcome)}`);
  assert.deepEqual([outcome.reason, outcome.message], ['model_error', FILTERED], 'the data-only short answer\'s turn failed with the content-filter text');
  assert.equal(sent.filter((url) => url.endsWith('/responses')).length, 1, 'one request: the refused answer is never asked for again');
});

test('a guard, through a gateway that sends each event as its data alone: an answer cut at its output limit (max_output_tokens) is no content-filter stop', { timeout: 60_000 }, async () => {
  const sent = [];
  const end = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage } };
  const node = createHarnessRunner(adapterOn(end, sent, '', false), { store: memorySessionStore(), tools: [], maxTurns: 2 });
  const outcome = await node(request).then((record) => ({ delivered: record }), (error) => error);
  assert.ok(outcome instanceof HarnessRunError, `the node delivered nothing: ${JSON.stringify(outcome)}`);
  assert.notEqual(outcome.message, FILTERED, 'not read as a content-filter stop');
});

test('a guard: an answer cut at its output limit (response.incomplete, reason max_output_tokens) is no content-filter stop', { timeout: 60_000 }, async () => {
  const sent = [];
  const end = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage } };
  const node = createHarnessRunner(adapterOn(end, sent), { store: memorySessionStore(), tools: [], maxTurns: 2 });
  const outcome = await node(request).then((record) => ({ delivered: record }), (error) => error);
  assert.ok(outcome instanceof HarnessRunError, `the node delivered nothing: ${JSON.stringify(outcome)}`);
  assert.notEqual(outcome.message, FILTERED, 'not read as a content-filter stop');
});

test("the policy reads a kept line start's stop whatever the gateway's JSON spacing or a field ahead of type, and only on the event's own type", () => {
  // A start the proxy kept of a terminal event's line longer than its windows (the rest of the line is cut).
  const start = (json) => `data: ${json.slice(0, 2048)}`;
  const body = { id: 'resp_1', object: 'response', status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [{ type: 'reasoning', encrypted_content: 'e'.repeat(4096) }] };
  const compact = JSON.stringify({ type: 'response.incomplete', response: body });
  const spaced = JSON.stringify({ type: 'response.incomplete', response: body }, null, 0).replaceAll('":', '": ').replaceAll(',"', ', "');
  const later = JSON.stringify({ sequence_number: 9, type: 'response.incomplete', response: body });
  for (const [label, json] of [['compact', compact], ['spaced', spaced], ['a field ahead of type', later]]) {
    assert.equal(filtered('', [start(json)]), true, `${label}: the stop is read from the kept start`);
  }
  // A guard: answer text that quotes the event (JSON-escaped in a delta) is no stop; nor an output limit.
  const quoted = JSON.stringify({ type: 'response.output_text.delta', delta: '"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"}}' });
  assert.equal(filtered('', [start(quoted)]), false, 'quoted text is no stop');
  const limited = JSON.stringify({ type: 'response.incomplete', response: { ...body, incomplete_details: { reason: 'max_output_tokens' } } });
  assert.equal(filtered('', [start(limited)]), false, 'an output limit is no filter stop');
});
