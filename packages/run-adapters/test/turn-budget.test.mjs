// The kernel's turn budget (process/turn-budget.ts): one tool result may take a share of the window (resultMaxChars),
// but a turn's results together must fit what the context has left. The budget starts from what the context already
// holds (the last model request's input tokens and its answer's output, where the model proxy reads them; else the
// session's fixed text, its system prompt and tool schemas, counted with o200k), keeps room for the model's answer, and
// splits what is left between the calls the answer made: each result is held to the smaller of its own bound and what
// is left this turn over the calls still unanswered. Below the least a cut keeps, a result is refused in words. A cut
// is recorded (`bound:<callId>`, its kept and whole lengths), so a replay gives the same cut and a harness compares a
// call's two records on the lengths, never on the note's words.
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { startModelProxy } from '@parcha/agentrun-kernel/host';
import { openDrive } from '@parcha/agentrun-kernel/kernel';
import * as processExports from '@parcha/agentrun-kernel/process';
import { memorySessionStore } from '@parcha/agentrun-kernel/testing';

const { RESULT_LEAST_KEPT_CHARS, toolBridge } = processExports;
/** The kernel's turn budget: absent before this change, so each test below fails on its absence, not at the import. */
const TurnBudget = processExports.TurnBudget;
const WINDOW = 16_384;
const CHARS_PER_TOKEN = 3;
const WINDOW_NOTE = /\n\[kept (\d+) of (\d+) characters: [^\n]*\]$/;

/** A drive on a session of `store` (a fresh one unless given). */
const driveOf = async (key, store = memorySessionStore()) => openDrive({ writer: await store.open(key), signal: new AbortController().signal });
/** A tool answering `size` characters, its start marked. */
const bigTool = (name, size) => ({ name, description: `${name}.`, inputSchema: { type: 'object' }, replay: 'safe', execute: async () => `START ${'r'.repeat(size - 6)}` });
/** The tokens a turn's context holds once its results are in: what it held, its answer, and each result at three characters a token. */
const contextAfter = (held, results) => held + Math.ceil(results.reduce((sum, r) => sum + r.text.length, 0) / CHARS_PER_TOKEN);

function assertCut(result, size) {
  assert.equal(result.truncated, true, `cut: ${result.text.length} of ${size}`);
  const m = WINDOW_NOTE.exec(result.text);
  assert.ok(m, `ends with the window's note: ${JSON.stringify(result.text.slice(-120))}`);
  assert.equal(Number(m[2]), size, 'the note names the whole length');
  assert.ok(Number(m[1]) >= RESULT_LEAST_KEPT_CHARS, `keeps a share, not refused: ${m[1]}`);
}

test('a 16k window, 4,000 tokens held, four parallel 10k results: together they stay under the window, each cut to a share', async () => {
  for (const serial of [true, false]) {
    const turn = new TurnBudget();
    const tools = ['a', 'b', 'c', 'd'].map((n) => bigTool(n, 10_000));
    const bridge = toolBridge(await driveOf(`four-${serial}`), tools, { budget: { contextWindow: WINDOW, turn }, serial });
    turn.open({ inputTokens: 4_000, outputTokens: 100, calls: 4 });
    const calls = tools.map((t, i) => () => bridge.call(t.name, {}, `call-${i}`));
    const results = serial ? [] : await Promise.all(calls.map((c) => c()));
    if (serial) for (const c of calls) results.push(await c());
    const total = contextAfter(4_100, results);
    assert.ok(total <= WINDOW, `${total} tokens after the results, past the ${WINDOW}-token window (serial ${serial})`);
    const reserve = Math.floor(WINDOW * processExports.ANSWER_RESERVE_SHARE);
    assert.ok(total <= WINDOW - reserve, `${total} tokens after the results: the ${reserve} kept for the model's answer are not left (serial ${serial})`);
    for (const r of results) assertCut(r, 10_000);
    const lengths = results.map((r) => r.text.length);
    assert.ok(Math.max(...lengths) - Math.min(...lengths) < 200, `an even split: ${lengths}`);
  }
});

test("a 200k window: the room kept for the model's answer is capped at 16,384 tokens, not a quarter of the window (50,000)", async () => {
  const BIG_WINDOW = 200_000;
  const CAP = 16_384;
  const HELD = 150_000;
  const turn = new TurnBudget();
  const tools = ['a', 'b', 'c', 'd'].map((n) => bigTool(n, 40_000));
  const bridge = toolBridge(await driveOf('big-window'), tools, { budget: { contextWindow: BIG_WINDOW, turn } });
  turn.open({ inputTokens: HELD, outputTokens: 0, calls: 4 });
  const results = await Promise.all(tools.map((t, i) => bridge.call(t.name, {}, `call-${i}`)));
  // With a quarter of the window held back, 150,000 + 50,000 leaves nothing, and each result would be refused.
  for (const r of results) assertCut(r, 40_000);
  const total = contextAfter(HELD, results);
  assert.ok(total <= BIG_WINDOW - CAP, `${total} tokens after the results: the ${CAP} kept for the answer are not left`);
  assert.ok(total > BIG_WINDOW - CAP - 300, `${total} tokens after the results: more than ${CAP} held back for the answer`);
});

test('a long history leaving 3k of a 16k window: a 10k result does not overflow it, is never passed whole, and is refused in words (the 4,096 kept for the answer take more than is left)', async () => {
  const turn = new TurnBudget();
  const bridge = toolBridge(await driveOf('history'), [bigTool('big', 10_000)], { budget: { contextWindow: WINDOW, turn } });
  turn.open({ inputTokens: 13_384, outputTokens: 0, calls: 1 });
  const result = await bridge.call('big', {}, 'call-1');
  assert.equal(result.truncated, true);
  assert.ok(contextAfter(13_384, [result]) <= WINDOW, `${contextAfter(13_384, [result])} tokens, past the window`);
  assert.ok(!result.text.includes('START') && !result.text.includes('rrrr'), `refused, none of it shown: ${result.text.slice(0, 200)}`);
  assert.match(result.text, /context window/);
});

test("what is left under the least a cut keeps: the result is refused in words, none of it shown", async () => {
  const turn = new TurnBudget();
  const bridge = toolBridge(await driveOf('refused'), [bigTool('big', 10_000)], { budget: { contextWindow: WINDOW, turn } });
  turn.open({ inputTokens: 16_000, outputTokens: 50, calls: 1 });
  const result = await bridge.call('big', {}, 'call-1');
  assert.equal(result.truncated, true);
  assert.ok(!result.text.includes('START') && !result.text.includes('rrrr'), result.text);
  assert.match(result.text, /context window/);
  assert.match(result.text, /10000 characters/);
});

test('a window known and no usage read: the session\'s fixed text, counted with o200k, comes off the window, and a result is never whole past what is left', async () => {
  // A system prompt of about 9,000 tokens: the share of what is left (16,384 - 9,000) is under 10k characters.
  const system = 'alpha beta gamma delta '.repeat(2_250);
  const turn = new TurnBudget([system]);
  const bridge = toolBridge(await driveOf('unread'), [bigTool('big', 10_000)], { budget: { contextWindow: WINDOW, turn } });
  const result = await bridge.call('big', {}, 'call-1');
  assertCut(result, 10_000);
  assert.ok(result.text.length <= Math.floor((WINDOW - 9_000) * 0.25 * CHARS_PER_TOKEN), `${result.text.length}`);
});

test('a cut is recorded by its lengths, and a replay of the call gives the same cut under a turn that would allow more', async () => {
  const store = memorySessionStore();
  const first = new TurnBudget();
  const bridge = toolBridge(await driveOf('replay', store), [bigTool('big', 10_000)], { budget: { contextWindow: WINDOW, turn: first } });
  first.open({ inputTokens: 10_000, outputTokens: 0, calls: 1 });
  const once = await bridge.call('big', {}, 'call-1');
  assertCut(once, 10_000);
  const kept = Number(WINDOW_NOTE.exec(once.text)[1]);
  const record = (await driveOf('replay', store)).state().effects.get(processExports.boundKey('call-1'));
  assert.equal(record?.status, 'completed', 'the cut is recorded');
  assert.deepEqual({ kept: record.output.kept, whole: record.output.whole }, { kept, whole: 10_000 });
  const again = new TurnBudget();
  const rerun = toolBridge(await driveOf('replay', store), [bigTool('big', 10_000)], { budget: { contextWindow: WINDOW, turn: again } });
  again.open({ inputTokens: 1_000, outputTokens: 0, calls: 1 });
  assert.equal((await rerun.call('big', {}, 'call-1')).text, once.text, 'the same cut, from its record');
});

test('the tool calls in an answer are counted from its stream: Messages, Responses and Chat Completions', () => {
  const { toolCallsIn } = processExports;
  const data = (event) => `data: ${JSON.stringify(event)}`;
  assert.equal(toolCallsIn(data({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} } })), 1);
  assert.equal(toolCallsIn(data({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })), 0);
  assert.equal(toolCallsIn(data({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 's', name: 'web_search', input: {} } })), 0, "a provider's own tool is not the client's call");
  assert.equal(toolCallsIn(data({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '' } })), 1);
  assert.equal(toolCallsIn(data({ type: 'response.output_item.added', output_index: 0, item: { type: 'custom_tool_call', call_id: 'call_2', name: 'exec', input: '' } })), 1);
  assert.equal(toolCallsIn(data({ type: 'response.output_item.added', output_index: 0, item: { type: 'message' } })), 0);
  assert.equal(toolCallsIn(data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read', arguments: '' } }, { index: 1, id: 'call_b', function: { name: 'read', arguments: '' } }] } }] })), 2);
  assert.equal(toolCallsIn(data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }] })), 0, "a call's later pieces are not new calls");
  assert.equal(toolCallsIn('data: {"type":"content_block_delta","delta":{"partial_json":"\\"tool_use\\""}}'), 0, 'words inside a value are not a call');
});

/** A Messages answer making `calls` tool calls, streamed, reporting `usage`. */
function messagesAnswer(calls) {
  const events = [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 4_000, output_tokens: 1 } } },
    ...Array.from({ length: calls }, (_, index) => [
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${index}`, name: 'read', input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index },
    ]).flat(),
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 100 } },
    { type: 'message_stop' },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

test("the session's model proxy opens the turn: the answer's input and output tokens and its four calls, before the harness can ask for a result's bound", async (t) => {
  const KEY = 'session-key-for-tests';
  const policy = {
    id: 'test',
    routes: [{ method: 'POST', path: '/v1/messages' }],
    keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
    authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
    apply: (body) => body,
    modelOf: (body) => body.model,
    usageOf: () => ({ input: 4_000, output: 100, cacheRead: 0 }),
  };
  const hooks = { beforeRequest: async () => ({ turn: 1 }), afterRequest: async () => {} };
  const fetch = async () => new Response(messagesAnswer(4), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const turn = new TurnBudget();
  const proxy = await startModelProxy({ policy, model: 'main-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks, price: () => 0, log: () => {}, fetch, turn }, KEY);
  t.after(() => proxy.close());
  const { hostname, port } = new URL(proxy.url);
  await new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      res.resume();
      res.on('end', resolve);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'main-model', stream: true, messages: [{ role: 'user', content: 'Read four files.' }] }));
  });
  // As a harness does: its calls at once, the moment the answer is read, with no wait of its own.
  const tools = ['a', 'b', 'c', 'd'].map((n) => bigTool(n, 10_000));
  const bridge = toolBridge(await driveOf('proxied'), tools, { budget: { contextWindow: WINDOW, turn } });
  const results = await Promise.all(tools.map((tool, i) => bridge.call(tool.name, {}, `toolu_${i}`)));
  const total = contextAfter(4_100, results);
  assert.ok(total <= WINDOW, `${total} tokens after the results, past the window`);
  for (const r of results) assertCut(r, 10_000);
});

test("a call that arrives while the proxy is still reading the answer waits for its usage: it gets its share of the split, not the whole room", async (t) => {
  const KEY = 'session-key-for-tests';
  const policy = {
    id: 'test',
    routes: [{ method: 'POST', path: '/v1/messages' }],
    keyOf: (headers) => String(headers.authorization ?? '').replace(/^Bearer /, ''),
    authHeaders: (credential) => ({ authorization: `Bearer ${credential}` }),
    apply: (body) => body,
    modelOf: (body) => body.model,
    usageOf: () => ({ input: 4_000, output: 100, cacheRead: 0 }),
  };
  const hooks = { beforeRequest: async () => ({ turn: 1 }), afterRequest: async () => {} };
  // The answer's four tool_use blocks reach the client at once; its end (and so its usage) only once released.
  const whole = messagesAnswer(4);
  const at = whole.indexOf('event: message_delta');
  let release;
  const released = new Promise((resolve) => (release = resolve));
  const encoder = new TextEncoder();
  const fetch = async () => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(whole.slice(0, at)));
      await released;
      controller.enqueue(encoder.encode(whole.slice(at)));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const turn = new TurnBudget();
  const proxy = await startModelProxy({ policy, model: 'main-model', origin: 'https://provider.invalid', credential: () => 'provider-secret', hooks, price: () => 0, log: () => {}, fetch, turn }, KEY);
  t.after(() => proxy.close());
  const { hostname, port } = new URL(proxy.url);
  let seenCalls;
  const callsSeen = new Promise((resolve) => (seenCalls = resolve));
  const answered = new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        if ((text.match(/"content_block_stop"/g) ?? []).length === 4) seenCalls();
      });
      res.on('end', resolve);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'main-model', stream: true, messages: [{ role: 'user', content: 'Read four files.' }] }));
  });
  // As a CLI that runs a call once its block is in: the four calls go before the answer has ended.
  await callsSeen;
  const tools = ['a', 'b', 'c', 'd'].map((n) => bigTool(n, 10_000));
  const bridge = toolBridge(await driveOf('racing'), tools, { budget: { contextWindow: WINDOW, turn } });
  let early = 0;
  const pending = tools.map((tool, i) => bridge.call(tool.name, {}, `toolu_${i}`).then((r) => ((early += released.done ? 0 : 1), r)));
  await new Promise((resolve) => setTimeout(resolve, 100));
  released.done = true;
  release();
  const results = await Promise.all(pending);
  await answered;
  assert.equal(early, 0, 'no call was bound before the answer it came from was read');
  const total = contextAfter(4_100, results);
  assert.ok(total <= WINDOW - Math.floor(WINDOW * processExports.ANSWER_RESERVE_SHARE), `${total} tokens after the results, past what the turn has (${results.map((r) => r.text.length)} characters)`);
  for (const r of results) assertCut(r, 10_000);
});

test("a result handed longer than its claim (whole under the always-whole floor) holds what it took: the calls after it split what is left", () => {
  // MUTATION: a settle that records the claim, not the length handed, leaves the next calls 80 characters the turn no longer has.
  // 300 tokens of room, three calls: 300 characters each. The first result, 380 characters, is handed whole (at most
  // RESULT_ALWAYS_WHOLE_CHARS is whole under any bound).
  const turn = new TurnBudget();
  const records = [];
  turn.journal((record) => void records.push(record));
  turn.open({ inputTokens: WINDOW - 300 - processExports.answerReserve(WINDOW), outputTokens: 0, calls: 3 });
  assert.equal(turn.claim('c1', WINDOW), 300);
  turn.settle('c1', 380);
  assert.equal(turn.claim('c2', WINDOW), Math.floor((900 - 380) / 2), 'the rest split over the two calls left');
  assert.deepEqual(records.at(-1), { settled: { callId: 'c1', chars: 380 } }, 'journaled at the length handed');
});
