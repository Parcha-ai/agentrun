// Goose's model proxy, driven as Goose 1.59.2 drives it (its routes and header names as recorded behind a fake origin),
// on the kernel's booking: what reaches the provider, what is answered here, what is refused, and how each paid request
// is booked and capped. No binary, no model: the provider is the fake origin.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelPortFor, RUNNER_RECORDS } from '@parcha/agentrun-kernel';
import { beforeRequestOf } from '@parcha/agentrun-kernel/kernel/cap';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';
import { applyGoose, GOOSE_BETAS, gooseProxy, goosePolicy, gooseUsage, limitGooseOutput } from '@parcha/agentrun-harness-acp';
import { fakeAnthropic } from './fake-anthropic.mjs';

const MODEL = 'claude-sonnet-5-5';
const PROVIDER_KEY = 'provider-key-the-agent-never-holds';
const BETA = [...GOOSE_BETAS][0];
/** $3 in, $15 out per million tokens. */
const RATES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const price = (_model, u) => (u.input * RATES.input + u.output * RATES.output + u.cacheRead * RATES.cacheRead + (u.cacheWrite ?? 0) * RATES.cacheWrite) / 1e6;

/** A Messages body as Goose sends one: adaptive thinking, an effort, cache markers, our tool and load_skill. */
const gooseBody = (extra = {}) => ({
  model: MODEL,
  max_tokens: 128000,
  system: [{ type: 'text', text: 'You are goose.', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'SAY hi' }, { type: 'text', text: '<turn-context></turn-context>', cache_control: { type: 'ephemeral' } }] }],
  tools: [
    { name: 'agentrun__echo', description: 'Echo.', input_schema: { type: 'object', properties: {} } },
    { name: 'load_skill', description: 'Load a skill.', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } },
  ],
  thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
  output_config: { effort: 'high' },
  stream: true,
  ...extra,
});

/** Goose's own request headers on a Messages request, by the names it sends. */
const gooseHeaders = (key, extra = {}) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': BETA, 'content-type': 'application/json', accept: '*/*', 'agent-session-id': '20261117_1', ...extra });

/** A proxy from the factory, on a booking of the session's own records, its origin the fake. */
async function started(t, { cap, usage } = {}) {
  const origin = await fakeAnthropic(usage ? { usage } : {});
  t.after(() => origin.close());
  const store = memorySessionStore();
  const writer = await store.open('s1');
  const ends = [];
  const booking = await modelPortFor(writer, {
    key: 's1',
    ...(cap === undefined ? {} : { beforeRequest: beforeRequestOf({ capUsd: () => cap, modelOf: (id) => ({ id, api: 'anthropic-messages', price: RATES, outputCeiling: 128000, reasoning: true }) }) }),
    onEvent: (event) => { if (event.type === 'request_end') ends.push(event.usage); },
  });
  const halted = [];
  const factory = gooseProxy({ model: MODEL, provider: { origin: origin.url, credential: () => PROVIDER_KEY }, price });
  const proxy = await factory({ models: booking.models, tools: ['echo'], halt: (reason) => halted.push(reason) });
  t.after(() => proxy.close());
  const url = proxy.env.ANTHROPIC_HOST;
  const key = proxy.env.ANTHROPIC_API_KEY;
  const post = (body, headers = gooseHeaders(key)) => fetch(`${url}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, text: await r.text() }));
  return { origin, store, writer, booking, ends, halted, proxy, url, key, post };
}

test('each Goose process is pointed at its proxy: plain http on loopback, and the session\'s own key, never the provider\'s', async (t) => {
  const { proxy, key } = await started(t);
  assert.deepEqual(Object.keys(proxy.env).sort(), ['ANTHROPIC_API_KEY', 'ANTHROPIC_HOST']);
  assert.match(proxy.env.ANTHROPIC_HOST, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(key, PROVIDER_KEY);
  assert.ok(key.length >= 32);
});

test('GET /v1/models is answered here with the run\'s model alone, to the session\'s key only, and never reaches the provider or the booking', async (t) => {
  const { origin, url, key, booking } = await started(t);
  const listed = await fetch(`${url}/v1/models`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', accept: '*/*' } });
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.deepEqual(body.data.map((m) => m.id), [MODEL]);
  assert.equal(body.has_more, false);
  for (const headers of [{}, { 'x-api-key': 'wrong' }, { 'x-api-key': PROVIDER_KEY }]) assert.equal((await fetch(`${url}/v1/models`, { headers })).status, 401);
  assert.equal(origin.requests.length, 0);
  assert.equal(booking.turns(), 0);
});

test('a Messages request reaches the provider with its credential, the API\'s version and Goose\'s beta, and never Goose\'s session id', async (t) => {
  const { origin, post, booking, ends, writer } = await started(t);
  const answer = await post(gooseBody());
  assert.equal(answer.status, 200, answer.text);
  assert.match(answer.text, /PLAIN_REPLY|hi/);
  const [sent] = origin.messages();
  assert.equal(sent.headers['x-api-key'], PROVIDER_KEY);
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');
  assert.equal(sent.headers['anthropic-beta'], BETA);
  assert.equal(sent.headers['agent-session-id'], undefined, "Goose's own session id stays here");
  assert.equal(sent.body.model, MODEL);
  // Booked once, at the host's price for what the answer reported.
  assert.equal(booking.turns(), 1);
  assert.equal(ends.length, 1);
  assert.deepEqual([ends[0].input, ends[0].output], [1000, 100]);
  assert.equal(ends[0].usd, price(MODEL, ends[0]));
  const turns = (await writer.read()).filter((r) => r.kind === RUNNER_RECORDS.turn);
  assert.equal(turns.length, 1);
  assert.equal(booking.spentUsd(), ends[0].usd);
});

test('what Goose may not send is refused before the provider is asked: another beta, another model, a tool the session lacks, a hosted tool, a foreign key', async (t) => {
  const { origin, post, key, url, booking } = await started(t);
  const refused = [
    [gooseBody(), gooseHeaders(key, { 'anthropic-beta': `${BETA},files-api-2025-04-14` }), 403],
    [gooseBody({ model: 'claude-opus-5-5' }), gooseHeaders(key), 403],
    [gooseBody({ tools: [...gooseBody().tools, { name: 'developer__shell', description: 'A shell.', input_schema: { type: 'object' } }] }), gooseHeaders(key), 403],
    [gooseBody({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] }), gooseHeaders(key), 403],
    [gooseBody({ mcp_servers: [] }), gooseHeaders(key), 403],
    [gooseBody({ messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } }] }] }), gooseHeaders(key), 403],
    [gooseBody(), gooseHeaders(PROVIDER_KEY), 401],
  ];
  for (const [body, headers, status] of refused) assert.equal((await post(body, headers)).status, status, JSON.stringify(body).slice(0, 120));
  // Only the listed routes: a path Goose does not call is refused too, even with the session's key.
  assert.equal((await fetch(`${url}/v1/messages/count_tokens`, { method: 'POST', headers: gooseHeaders(key), body: '{}' })).status, 403);
  assert.equal(origin.requests.length, 0);
  assert.equal(booking.turns(), 0);
});

test('under a cap, a request is admitted with its output limited to what is left, and one past the cap is refused unsent and unbooked', async (t) => {
  // Each answer reports 6,000 output tokens: $0.093 a request at these rates. The cap is $0.10.
  const { origin, post, booking, ends } = await started(t, { cap: 0.1, usage: { input_tokens: 1000, output_tokens: 6000 } });
  const first = await post(gooseBody());
  assert.equal(first.status, 200, first.text);
  const sent = origin.messages()[0].body;
  assert.ok(sent.max_tokens < 128000, `the cap limited the output to ${sent.max_tokens}`);
  assert.ok(sent.max_tokens >= 1024);
  const second = await post(gooseBody());
  assert.equal(second.status, 400, 'a status Goose takes as the request refused');
  assert.match(second.text, /spend_cap_reached/);
  assert.equal(origin.messages().length, 1, 'the refused request never reached the provider');
  assert.equal(ends.length, 1);
  assert.equal(booking.spentUsd(), ends[0].usd);
  assert.ok(ends[0].usd > 0.09);
});

test('the policy: a body as Goose sends it passes with its max_tokens clamped, and its output limit and usage are read as the API writes them', () => {
  const policy = goosePolicy({ model: MODEL, tools: ['echo'], maxOutputTokens: 64000 });
  assert.deepEqual(policy.routes.map((r) => `${r.method} ${r.path}${r.local ? ` (here, ${r.local})` : ''}`), ['GET /v1/models (here, 200)', 'POST /v1/messages']);
  assert.deepEqual(policy.routes[1].headers, ['anthropic-version', 'anthropic-beta']);
  const out = applyGoose(gooseBody(), { model: MODEL, tools: ['echo'], maxOutputTokens: 64000 });
  assert.equal(out.max_tokens, 64000);
  assert.deepEqual(out.thinking, gooseBody().thinking);
  assert.equal(policy.keyOf({ 'x-api-key': 'k' }), 'k');
  assert.deepEqual(policy.authHeaders('c'), { 'x-api-key': 'c' });
  assert.deepEqual(goosePolicy({ model: MODEL, tools: [], auth: 'bearer' }).authHeaders('c'), { authorization: 'Bearer c' });
  assert.equal(policy.outputAsked(out), 64000);
  assert.equal(policy.reasoningHidden(out), 64000, 'adaptive thinking may bill up to its max_tokens unseen');
  assert.equal(policy.effortOf(out), 'high');
  assert.equal(limitGooseOutput(out, 2000).max_tokens, 2000);
  assert.equal(limitGooseOutput({ ...out, thinking: { type: 'enabled', budget_tokens: 30000 } }, 4000).thinking.budget_tokens, 2976);
  const stream = [
    'event: message_start', `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 1 } } })}`, '',
    'event: message_delta', `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } })}`, '',
    'event: message_stop', `data: ${JSON.stringify({ type: 'message_stop' })}`, '',
  ].join('\n');
  assert.deepEqual(gooseUsage(stream), { input: 12, output: 40, cacheRead: 3, cacheWrite: 0 });
  assert.equal(gooseUsage(stream.split('event: message_stop')[0]), undefined, 'a stream that never stopped is unknown');
  assert.equal(policy.filtered(stream.replace('end_turn', 'refusal'), []), true);
  assert.equal(policy.filtered(stream, []), false);
  const noted = policy.addNote(out, 'wrap up');
  assert.deepEqual(noted.messages.at(-1).content.at(-1), { type: 'text', text: '<system-reminder>wrap up</system-reminder>' });
  assert.equal(noted.messages.length, out.messages.length);
  assert.throws(() => policy.header('anthropic-beta', 'context-1m-2025-08-07'), /anthropic-beta/);
  assert.equal(policy.header('anthropic-beta', BETA), BETA);
});
