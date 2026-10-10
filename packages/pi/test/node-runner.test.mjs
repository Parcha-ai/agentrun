// The node runner behind `runNode`, on the in-memory storage with a scripted model: one extension serves every node,
// and each node's conversation sees its own system text, task and `submit`. Each test counts the model's requests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { memoryStore, openRecovery, runStoppedError, withRecovery } from '@parcha/agentrun-dsl/recovery';
import { hostScope, NodeIndex } from '../dist/durable/node.js';
import { NodeDoc, NodeFailure, nodeRunner } from '../dist/durable/node-runner.js';
import { RecordDoc } from '../dist/durable/record-tool.js';

const MODEL = { provider: 'faux', modelId: 'faux-1' };
const VERDICT = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string', description: 'buy or pass' } } };
const SCORE = { type: 'object', additionalProperties: false, required: ['score'], properties: { score: { type: 'integer' } } };
const submit = (args) => fauxAssistantMessage([fauxToolCall('submit', args)], { stopReason: 'toolUse' });
const say = (text) => fauxAssistantMessage(text);
const step = (attempt = 0, at = 0) => ({ sessionId: `run-1:step:/root/steps/${at}:a${attempt}`, attempt, earlierSessionIds: Array.from({ length: attempt }, (_, earlier) => `run-1:step:/root/steps/${at}:a${earlier}`) });
const verdict = (extra = {}) => ({ kind: 'decide', label: 'Verdict', executionPath: '/root/steps/0', system: ['The procedure, section 2.', 'Decide buy or pass.'], user: '{"claim":"x"}', schema: VERDICT, step: step(), ...extra });
const systemOf = (messages) => messages.find((message) => message.role === 'system');
const submitOf = (messages) => messages.flatMap((message) => message.toolsAdded ?? []).find((tool) => tool.name === 'submit');
const toolResults = (messages) => messages.filter((message) => message.role === 'toolResult').map((message) => message.content.map((block) => block.text ?? '').join(''));
const final = (pattern) => (error) => error instanceof NodeFailure && error.final === true && error.code === 'NODE_NOT_DELIVERED' && pattern.test(error.message);

/** A Harness with the runner's extension, a host over a scripted model, and what the model was sent. */
async function rig(turns, host = {}, extensions = []) {
  const requests = [];
  const faux = fauxProvider();
  faux.setResponses(turns.map((turn) => async (context, options) => { requests.push(JSON.parse(JSON.stringify(context.messages))); return typeof turn === 'function' ? turn(context, options) : turn; }));
  const models = createModels();
  models.setProvider(faux.provider);
  const opened = [];
  const nodes = nodeRunner({ agent: () => ({ model: MODEL }), onNodeOpen: (node) => { opened.push({ conversation: Number(node.conversationId), attempt: node.attempt, resumed: node.resumed }); }, ...host });
  const registry = createRegistry();
  registry.install(nodes.extension);
  for (const extension of extensions) registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  return { harness, nodes, requests, opened, ...nodes.on(hostScope(harness), ctx) };
}

test('a node\'s first request carries its system text, its task with the delivery contract, and submit as its own record\'s tool', async () => {
  const { harness, runNode, requests, opened } = await rig([submit({ verdict: 'buy' }), say('never asked')],
    { stance: (node, offered) => `Stance for ${node.kind} with ${offered.tools.length} tools.` });
  assert.deepEqual(await runNode(verdict()), { verdict: 'buy' });
  assert.equal(requests.length, 1, 'the record ends the node\'s run');
  const [first] = requests;
  assert.deepEqual(systemOf(first).sections, { task: 'The procedure, section 2.\n\nDecide buy or pass.\n\nStance for decide with 0 tools.' });
  assert.equal(first.find((message) => message.role === 'user').content, ['{"claim":"x"}',
    'When you are done, call the `submit` tool ONCE with the Verdict record as its arguments. The arguments are validated against the required schema; if validation fails you get the problems back and may fix and resubmit.',
    `Required JSON Schema (authoritative): ${JSON.stringify(VERDICT)}`,
    'Only a successful `submit` call counts as delivering. Do not answer in plain text.'].join('\n'));
  assert.deepEqual(submitOf(first), { name: 'submit', description: 'Deliver the Verdict record. Submit it inline as the tool arguments. It ends the run.',
    parameters: { type: 'object', additionalProperties: true, properties: { verdict: { type: 'string', description: 'buy or pass' } } } });
  assert.deepEqual(opened, [{ conversation: opened[0].conversation, attempt: 0, resumed: false }]);
  await harness.close(ctx);
});

test('two nodes with different records run at once on the one extension, and each sees and is held to its own', async () => {
  const answer = (context) => submitOf(context.messages).description.includes('Score') ? submit({ score: '7' }) : submit({ verdict: 'pass' });
  const { harness, nodes, runNode, requests } = await rig([answer, answer]);
  const [a, b] = await Promise.all([
    runNode(verdict()),
    runNode({ kind: 'extract', label: 'Score', executionPath: '/root/steps/1', system: ['Score it.'], user: '{}', schema: SCORE, step: step(0, 1) }),
  ]);
  assert.deepEqual([a, b], [{ verdict: 'pass' }, { score: 7 }], 'each record repaired and held against its own schema');
  assert.deepEqual(requests.map((messages) => Object.keys(submitOf(messages).parameters.properties)).sort(), [['score'], ['verdict']]);
  assert.deepEqual(requests.map((messages) => systemOf(messages).sections.task).sort(), ['Score it.', 'The procedure, section 2.\n\nDecide buy or pass.']);
  assert.deepEqual(nodes.extension.tools.map((tool) => tool.name), ['submit']);
  await harness.close(ctx);
});

test('the host\'s reading and the node\'s verify clause are one round: the first record goes back with both, the next is delivered', async () => {
  const read = [];
  const { harness, runNode, requests } = await rig([submit({ verdict: 'hold' }), submit({ verdict: 'hold' }), say('never asked')], {
    verify: (record, node, at) => { read.push([node.label, at.round]); return [{ id: 'policy', kind: 'host', verdict: 'fails', reasons: ['names no decision'] }]; },
  });
  const record = await runNode(verdict({ review: async (candidate) => candidate.verdict === 'buy' ? { accepted: true } : { accepted: false, message: 'say buy or pass' } }));
  assert.deepEqual(record, { verdict: 'hold' }, 'the second structurally valid record is the record');
  assert.deepEqual(toolResults(requests[1]), ['policy (host): fails - names no decision\nverify (verify): fails - /: violates "the verify clause of Verdict" - say buy or pass']);
  assert.deepEqual(read, [['Verdict', true], ['Verdict', false]]);
  assert.match(requests[0].find((message) => message.role === 'user').content, /\nA schema-valid record is then reviewed against the procedure that governs this run before it is accepted; /);
  assert.equal(requests.length, 2);
  await harness.close(ctx);
});

test('a step asked again answers from its record with no request; a call outside a journal is a conversation of its own', async () => {
  const { harness, runNode, requests, opened } = await rig([submit({ verdict: 'buy' }), submit({ verdict: 'pass' }), submit({ verdict: 'hold' })]);
  assert.deepEqual(await runNode(verdict()), { verdict: 'buy' });
  assert.deepEqual(await runNode(verdict()), { verdict: 'buy' }, 'the attempt\'s own record');
  assert.equal(requests.length, 1);
  assert.deepEqual(opened.map((at) => at.resumed), [false, true]);
  assert.equal(opened[1].conversation, opened[0].conversation);
  const { step: _none, ...unjournaled } = verdict();
  assert.deepEqual([await runNode(unjournaled), await runNode(unjournaled)], [{ verdict: 'pass' }, { verdict: 'hold' }]);
  assert.equal(new Set(opened.map((at) => at.conversation)).size, 3);
  await harness.close(ctx);
});

test('a schema the record lint refuses fails the node before any conversation exists', async () => {
  const { harness, runNode, requests, opened } = await rig([say('never asked')]);
  await assert.rejects(runNode(verdict({ schema: { type: 'object', required: ['verdict', 'missing'], properties: { verdict: { type: 'string' } } } })),
    final(/^decide node "Verdict" cannot deliver a record of its schema: /));
  assert.deepEqual([requests.length, opened.length], [0, 0]);
  await harness.close(ctx);
});

test('a node that spends its delivery attempts fails for good, by rejections or by yields without a record', async () => {
  const rejected = await rig([submit({ nope: 1 }), submit({ nope: 2 }), say('never asked')], { maxAttempts: 2 });
  await assert.rejects(rejected.runNode(verdict()), final(/^Verdict did not submit \(its delivery attempts are spent\)$/));
  assert.equal(rejected.requests.length, 2);
  await rejected.harness.close(ctx);
  const silent = await rig([say('thinking'), say('still thinking'), say('I am done.'), say('never asked')], { maxAttempts: 2 });
  await assert.rejects(silent.runNode(verdict()), final(/its delivery attempts are spent/));
  assert.equal(silent.requests.length, 3, 'two nudges are the two attempts');
  assert.equal(silent.requests[1].filter((message) => message.role === 'user').at(-1).content, 'You stopped without submitting. Call submit with the Verdict record, complete.');
  await silent.harness.close(ctx);
});

test('a run a host tool ended without a record is a failure a second attempt may follow', async () => {
  const halt = defineTool({ name: 'halt', description: 'Stop.', parameters: { type: 'object', additionalProperties: true }, execute: async () => ({ content: [{ type: 'text', text: 'stopped' }], control: { terminate: true } }) });
  const tools = defineExtension({ name: 'host-tools', tools: [halt] });
  const seen = [];
  const { harness, nodes, runNode, requests } = await rig([fauxAssistantMessage([fauxToolCall('halt', {})], { stopReason: 'toolUse' }), say('never asked')],
    { agent: () => ({ model: MODEL, extensions: [tools], tools: [halt] }), stance: (_node, offered) => { seen.push(offered.tools); return undefined; } }, [tools]);
  await assert.rejects(runNode(verdict()), (error) => error instanceof NodeFailure && error.final === false && /^Verdict did not submit \(it ended its run without a record\)$/.test(error.message));
  assert.deepEqual(seen, [['halt']], 'the stance is told the tools the host\'s agent lists');
  assert.deepEqual(requests[0].flatMap((message) => message.toolsAdded ?? []).map((tool) => tool.name), ['halt', 'submit'], 'submit follows the host\'s tools');
  assert.equal(nodes.extension.name, 'agentrun-nodes');
  await harness.close(ctx);
});

test('a pause leaves the node\'s work for the attempt\'s next entry; any other stop ends it', async () => {
  for (const [reason, kept] of [[runStoppedError('pause'), true], [runStoppedError('cancel'), false], [new Error('a sibling failed'), false]]) {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let asked;
    const reachedModel = new Promise((resolve) => { asked = resolve; });
    // The scripted request ends when it is released, or when its own abort signal fires, as a provider's does.
    const { harness, runNode, requests } = await rig([async (_context, options) => {
      asked();
      await Promise.race([held, new Promise((resolve) => options?.signal?.addEventListener('abort', resolve, { once: true }))]);
      return submit({ verdict: 'buy' });
    }, say('never asked')]);
    const stop = new AbortController();
    const running = runNode(verdict({ signal: stop.signal }));
    await reachedModel;
    stop.abort(reason);
    await assert.rejects(running, (error) => error === reason);
    release();
    if (kept) assert.deepEqual(await runNode(verdict()), { verdict: 'buy' }, 'the request in flight at the pause delivers to the attempt\'s next entry');
    else await assert.rejects(runNode(verdict()), (error) => final(/^Verdict: the model did not answer \(aborted\)$/)(error) && error.unanswered?.reason === 'aborted');
    assert.equal(requests.length, 1);
    await harness.close(ctx);
  }
});

test('a conversation that is no node is left as it is: no task section, no nudge, and submit refuses it', async () => {
  const { harness, requests } = await rig([say('hello'), submit({ verdict: 'buy' }), say('done')]);
  const plain = await harness.root(ctx, { agent: { model: MODEL } });
  assert.equal((await (await plain.submit({ type: 'input', content: 'Chat.', requestId: 'chat-1' }, ctx)).wait(ctx)).status, 'done');
  assert.equal(requests.length, 1, 'a yield of a conversation that owes no record is not nudged');
  assert.equal(systemOf(requests[0])?.sections?.task, undefined);
  await (await plain.submit({ type: 'input', content: 'Submit anyway.', requestId: 'chat-2' }, ctx)).wait(ctx);
  assert.match(toolResults(requests.at(-1)).at(-1), /submit was called in a conversation that is no workflow node/);
  assert.equal(await harness.snapshot(RecordDoc, plain.id, ctx), undefined);
  await harness.close(ctx);
});

test('under the recovery driver a failed attempt is closed and the second is a new conversation that delivers', async () => {
  const halt = defineTool({ name: 'halt', description: 'Stop.', parameters: { type: 'object', additionalProperties: true }, execute: async () => ({ content: [{ type: 'text', text: 'stopped' }], control: { terminate: true } }) });
  const tools = defineExtension({ name: 'host-tools', tools: [halt] });
  const asked = [];
  const written = [];
  const { harness, runNode, closeStepSession, requests, opened } = await rig(
    [fauxAssistantMessage([fauxToolCall('halt', {})], { stopReason: 'toolUse' }), submit({ verdict: 'buy' }), say('never asked')],
    { agent: (node) => { asked.push({ sessionId: node.sessionId, attempt: node.attempt, earlierSessionIds: node.earlierSessionIds }); return { model: MODEL, extensions: [tools] }; },
      init: async (node, tx, id) => { written.push([node.attempt, Number(id), (await tx.doc(NodeDoc, id)).label]); } }, [tools]);
  const workflow = { v: 2, name: 'one-node', schemas: { Verdict: VERDICT, Out: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' } } } },
    output: { schemaId: 'Out', path: 'decision' }, root: { node: 'chain', steps: [{ node: 'decide', label: 'Verdict', instructions: 'Decide buy or pass.', out: 'Verdict', as: 'decision' }] } };
  const store = memoryStore();
  const closed = [];
  const driver = await openRecovery(store, workflow, { key: 'run-1', closeStepSession: async (sessionId) => { closed.push(sessionId); await closeStepSession(sessionId); } });
  let result;
  try { result = await runWorkflow(workflow, { claim: 'x' }, withRecovery(driver, { runNode }, { durableNodes: true })); } finally { await driver.close(); }
  assert.deepEqual(result.output, { verdict: 'buy' });
  assert.deepEqual(opened.map((at) => [at.attempt, at.resumed]), [[0, false], [1, false]]);
  assert.notEqual(opened[0].conversation, opened[1].conversation);
  assert.equal(requests.length, 2);
  assert.equal(closed.length, 1);
  assert.deepEqual(asked.map((node) => [node.attempt, node.earlierSessionIds]), [[0, []], [1, [asked[0].sessionId]]], 'the host is told each attempt and the sessions before it');
  assert.equal(closed[0], asked[0].sessionId);
  assert.deepEqual(written, [[0, opened[0].conversation, 'the Verdict record'], [1, opened[1].conversation, 'the Verdict record']], 'the host writes in each creating commit, after the runner\'s document');
  assert.deepEqual({ ...(await harness.snapshot(NodeIndex, closed[0], ctx)), startedMs: 0, digest: '' }, { conversation: opened[0].conversation, digest: '', startedMs: 0, closed: true });
  await harness.close(ctx);
});
