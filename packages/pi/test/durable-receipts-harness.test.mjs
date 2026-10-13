// What reuseReceipts does through a real pi-durable Harness, the place a tool result's shape matters: the text the model
// receives for a refusal and for an answer from a receipt, the value a paid receipt stores, and that a failure is no paid
// result. The unit tests in durable-receipts.test.mjs hand the wrapper plain objects; these run it as a registered tool
// under a conversation, so a site that reads or writes the wrong key of the result fails here.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { canonicalHash } from '@parcha/agentrun-dsl/recovery';
import { ReceiptIndex, reuseReceipts, seedReceipts } from '@parcha/agentrun-pi/durable';

const root = mkdtempSync(join(tmpdir(), 'agentrun-receipts-harness-'));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;

const textOf = (message) => (message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');

/** A paid tool that records its calls and answers with `answer` (a result object). */
function paidTool(name, answer, calls) {
  return defineTool({
    name, description: 'a paid external call',
    parameters: { type: 'object', additionalProperties: true, properties: {} },
    execute: async (args) => { calls.push(args); return answer; },
  });
}

/** Run one conversation on a real Harness: the model calls `call` once (`[tool, args]`), then answers. Resolves with the tool
 *  result the model received, the Harness (still open, for reading the stored receipts) and a closer. */
async function converse({ tool, call, options, seed }) {
  const reuse = reuseReceipts({ tools: [tool.name], sessionId: 'tail', answer: true, ...options });
  const extension = defineExtension({ name: 'paid', tools: [reuse.wrap(tool)] });
  const faux = fauxProvider({ models: [{ id: 'faux-1' }] });
  const policy = (context) => context.messages.filter((m) => m.role === 'assistant').length === 0
    ? fauxAssistantMessage([fauxToolCall(call[0], call[1])], { stopReason: 'toolUse' }) : fauxAssistantMessage([fauxText('done')], { stopReason: 'stop' });
  faux.setResponses([policy, policy, policy]);
  const models = createModels(); models.setProvider(faux.provider);
  const registry = createRegistry(); registry.install(extension);
  const harness = await Harness.open(await openNodeSqliteStorage(join(root, `run-${counter += 1}.sqlite`)), { models, registry }, ctx);
  if (seed) await seedReceipts(harness, seed, 'driver');
  const conversation = await harness.root(ctx, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
  await (await conversation.submit({ type: 'input', content: 'go', requestId: 'go-1' }, ctx)).wait(ctx);
  const page = await conversation.entries({}, 50, undefined, ctx);
  const results = [...page.items].reverse().filter((entry) => entry.kind === 'pi.tool-result').map((entry) => ({ text: textOf(entry.model[0]), isError: entry.model[0].isError === true, details: entry.model[0].details ?? null }));
  return { results, harness, reuse, close: () => harness.close(ctx) };
}
const storedFor = (harness, tool, args) => harness.snapshot(ReceiptIndex, `${tool}:${canonicalHash(args)}`, ctx);

test('the model receives the refusal text for a call equal to an effect whose outcome is unknown, and the tool is not called', async () => {
  const calls = [];
  const args = { amount: 5 };
  const run = await converse({ tool: paidTool('pay', { content: [{ type: 'text', text: 'paid' }] }, calls), call: ['pay', args],
    options: { unknown: [{ name: 'pay', argsHash: canonicalHash(args) }] } });
  try {
    assert.deepEqual(calls, []);
    assert.equal(run.results.length, 1);
    assert.equal(run.results[0].text, 'pay is not called again: an identical earlier call was cut while it ran, so what it did outside is unknown. Work from what you have, or make a different call.');
    assert.equal(run.results[0].isError, true);
    assert.equal(run.results[0].details?.effect_status, 'unknown');
  } finally { await run.close(); }
});

test('the model receives the receipt\'s text, and where it came from, for a repeat of a call another session paid for', async () => {
  const calls = [];
  const args = { q: 'acme' };
  const run = await converse({ tool: paidTool('search', { content: [{ type: 'text', text: 'LIVE' }] }, calls), call: ['search', args],
    seed: [{ tool: 'search', argsHash: canonicalHash(args), result: 'PAID ROW 7', session: 'driver-step' }] });
  try {
    assert.deepEqual(calls, [], 'the call was answered, not dispatched');
    assert.equal(run.results[0].text, 'PAID ROW 7\n\n(answered from the paid receipt of driver-step; the call was not dispatched again)');
    assert.equal(run.results[0].isError, false);
    assert.equal(run.results[0].details?.effect_status, 'reused');
  } finally { await run.close(); }
});

test('the stored receipt value equals the tool\'s text, and names the session that paid', async () => {
  const calls = [];
  const args = { q: 'acme' };
  const run = await converse({ tool: paidTool('search', { content: [{ type: 'text', text: 'ROW A' }, { type: 'text', text: 'ROW B' }] }, calls), call: ['search', args] });
  try {
    assert.equal(calls.length, 1);
    assert.equal(run.results[0].text, 'ROW AROW B', 'the model received the tool\'s own text');
    const stored = await storedFor(run.harness, 'search', args);
    assert.equal(stored?.result, 'ROW A\nROW B', 'the receipt holds the tool\'s text blocks, joined');
    assert.equal(stored?.session, 'tail');
    assert.equal(stored?.tool, 'search');
  } finally { await run.close(); }
});

test('a failure is not recorded as a paid result: an error result, and a failure envelope in the text', async () => {
  for (const [label, answer] of [
    ['an error result', { isError: true, content: [{ type: 'text', text: 'the provider answered 500' }] }],
    ['a failure envelope as the text', { content: [{ type: 'text', text: '{"ok":false,"error":"not found"}' }] }],
    ['a failure envelope among the text blocks', { content: [{ type: 'text', text: 'fetching' }, { type: 'text', text: '{"outcome":"error"}' }] }],
  ]) {
    const args = { q: label };
    const run = await converse({ tool: paidTool('search', answer, []), call: ['search', args] });
    try {
      assert.equal(run.results.length, 1, label);
      const stored = await storedFor(run.harness, 'search', args);
      assert.ok(!stored || stored.result === null, `${label}: nothing is stored`);
    } finally { await run.close(); }
  }
});

test('a seeded receipt of a call that returned nothing is answered, not dispatched again', async () => {
  const calls = [];
  const args = { q: 'nothing' };
  const run = await converse({ tool: paidTool('search', { content: [{ type: 'text', text: 'LIVE' }] }, calls), call: ['search', args],
    seed: [{ tool: 'search', argsHash: canonicalHash(args), result: null, session: 'driver-step' }] });
  try {
    assert.deepEqual(calls, [], 'the call was paid and returned nothing: dispatching it again buys the same nothing twice');
    assert.equal(run.results[0].text, 'null\n\n(answered from the paid receipt of driver-step; the call was not dispatched again)');
    assert.equal(run.results[0].details?.effect_status, 'reused');
  } finally { await run.close(); }
});
