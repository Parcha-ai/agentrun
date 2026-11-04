// A request the host admitted with an output limit (its ticket's `outputTokensMax`, what is left of a spend cap can buy)
// reaches the provider with max_output_tokens at most that limit, through the session's model proxy under the Codex
// policy, on the request the pinned CLI sends (test/fixtures). No network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { test } from 'node:test';
import * as host from '@parcha/agentrun-kernel/host';
import { codexPolicy } from '../dist/host/policy.js';

const { startModelProxy } = host;
const KEY = 'session-key-for-tests';
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const RECORDED_REQUEST = JSON.parse(fixture('responses-request-gpt-5.4-mini.json'));
const RECORDED_STREAM = fixture('responses-stream-gpt-5.4-mini.sse');

function send(url, body) {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, accept: 'text/event-stream', 'session-id': 'sid', 'thread-id': 'tid', 'x-client-request-id': 'rid', 'x-codex-window-id': 'wid', originator: 'codex_exec' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** A proxy under the Codex policy whose host admits each request with `limit` output tokens (none: no limit). */
async function admitting(t, limit) {
  const sent = [];
  const asked = [];
  const p = await startModelProxy({
    policy: codexPolicy({ model: 'session-model', tools: ['lookup'] }), model: 'session-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', price: () => 0.001, log: () => {},
    hooks: { beforeRequest: async (r) => { asked.push(r); return { turn: 1, ...(limit === undefined ? {} : { outputTokensMax: limit }) }; }, afterRequest: async () => {} },
    fetch: async (_url, init) => { sent.push(String(init.body)); return new Response(RECORDED_STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } }); },
  }, KEY);
  t.after(() => p.close());
  return { p, sent, asked, forwarded: () => sent.map((raw) => JSON.parse(raw)) };
}

test('a request admitted with an output limit reaches the provider with max_output_tokens at that limit', async (t) => {
  const { p, forwarded } = await admitting(t, 5_000);
  assert.equal((await send(p.url, RECORDED_REQUEST)).status, 200);
  assert.equal(forwarded()[0].max_output_tokens, 5_000);
});

test('a limit above what the CLI asked for raises nothing: its own max_output_tokens goes', async (t) => {
  const { p, forwarded } = await admitting(t, 5_000);
  assert.equal((await send(p.url, { ...RECORDED_REQUEST, max_output_tokens: 2_000 })).status, 200);
  assert.equal(forwarded()[0].max_output_tokens, 2_000);
});

test('the body sent is never longer than the one its input bound was measured on', async (t) => {
  const { p, sent, asked } = await admitting(t, 5_000);
  assert.equal((await send(p.url, RECORDED_REQUEST)).status, 200);
  const measured = asked[0].inputTokensMax;
  assert.ok(typeof measured === 'number' && Buffer.byteLength(sent[0], 'utf8') <= measured, `${Buffer.byteLength(sent[0], 'utf8')} bytes sent, ${measured} measured`);
});

test('with no limit (no cap) the body goes as the policy shapes it', async (t) => {
  const { p, forwarded } = await admitting(t, undefined);
  assert.equal((await send(p.url, RECORDED_REQUEST)).status, 200);
  assert.equal(forwarded()[0].max_output_tokens, 32_000, "the policy's own ceiling");
});
