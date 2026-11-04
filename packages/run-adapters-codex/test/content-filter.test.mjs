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

process.env.AGENTRUN_CODEX_STANDIN = '1';
const FAKE = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'agentrun-codex-filter-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));
/** The text a turn the provider's content filter stopped ends with (the kernel's CONTENT_FILTERED). */
const FILTERED = 'content_filter: the model provider stopped this answer';
const SCHEMA = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };
const request = { kind: 'agent', label: 'filtered', system: [], user: 'What is 2 plus 2?', schema: SCHEMA, tools: [] };

/** A Responses stream, each event named on its own line as the provider names it: `text` (in pieces of at most 4 KiB),
 *  then its last event, `end`. */
const stream = (text, end) => {
  const pieces = text ? text.match(/[\s\S]{1,4096}/g) : [''];
  return `${[...pieces.map((delta) => ({ delta, type: 'response.output_text.delta' })), end].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
};
const usage = { input_tokens: 12, output_tokens: 0 };

function adapterOn(end, sent, text = '') {
  const dir = mkdtempSync(join(ROOT, 'n-'));
  const fetch = async (input) => {
    sent.push(String(input instanceof Request ? input.url : input));
    return new Response(stream(text, end), { status: 200, headers: { 'content-type': 'text/event-stream' } });
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

test('a guard: an answer cut at its output limit (response.incomplete, reason max_output_tokens) is no content-filter stop', { timeout: 60_000 }, async () => {
  const sent = [];
  const end = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage } };
  const node = createHarnessRunner(adapterOn(end, sent), { store: memorySessionStore(), tools: [], maxTurns: 2 });
  const outcome = await node(request).then((record) => ({ delivered: record }), (error) => error);
  assert.ok(outcome instanceof HarnessRunError, `the node delivered nothing: ${JSON.stringify(outcome)}`);
  assert.notEqual(outcome.message, FILTERED, 'not read as a content-filter stop');
});
