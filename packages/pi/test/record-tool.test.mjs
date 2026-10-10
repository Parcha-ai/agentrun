// The record core on pi-durable: a conversation's `submit` tool over its two documents, on the in-memory storage
// with a scripted model. Each test counts the model's requests, so "ends the run" means no request after it.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { workspaceRecordFile } from '../dist/durable/record-file.js';
import { deliveredRecord, GateDoc, RecordDoc, recordNudge, recordTool, spendNudge } from '../dist/durable/record-tool.js';

const MODEL = { provider: 'faux', modelId: 'faux-1' };
const SCHEMA = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string', description: 'buy or pass' }, score: { type: 'integer' } } };
const submit = (args) => fauxAssistantMessage([fauxToolCall('submit', args)], { stopReason: 'toolUse' });
const say = (text) => fauxAssistantMessage(text);
const objection = (reason) => ({ id: 'verify', kind: 'verify', verdict: 'fails', reasons: [reason] });

/** One conversation with the `submit` tool and the nudge installed, driven by `turns`. Returns what a host reads. */
async function run(turns, contract = {}, toolOptions = {}) {
  const requests = [];
  const deliveries = [];
  const faux = fauxProvider();
  faux.setResponses(turns.map((turn) => (context) => { requests.push(context); return typeof turn === 'function' ? turn(context) : turn; }));
  const models = createModels();
  models.setProvider(faux.provider);
  let conversation;
  const tool = recordTool({
    schema: SCHEMA, label: 'the verdict record', ...toolOptions,
    contract: () => ({ schema: SCHEMA, ...contract }),
    onDelivery: (delivery) => { deliveries.push(delivery.status); },
  });
  const nudge = recordNudge({
    label: () => 'the verdict record', maxAttempts: contract.maxAttempts,
    spend: (id, context) => conversation.commit((tx) => spendNudge(tx, id), context),
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'record-test', tools: [tool], hooks: [nudge] }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  conversation = await harness.root(ctx, { agent: { model: MODEL } });
  const settled = await (await conversation.submit({ type: 'input', content: 'Decide.', requestId: 'node:test' }, ctx)).wait(ctx);
  const record = await harness.snapshot(RecordDoc, conversation.id, ctx);
  const gate = await harness.snapshot(GateDoc, conversation.id, ctx);
  const delivered = await deliveredRecord(harness, conversation.id, ctx);
  const toolResults = requests.map((context) => context.messages.filter((m) => m.role === 'toolResult').map((m) => m.content.map((c) => c.text ?? '').join('')));
  // A request carries the tools it offers on the message that introduces them.
  const tools = requests[0]?.messages.flatMap((message) => message.toolsAdded ?? []) ?? [];
  await harness.close(ctx);
  return { settled, record, gate, delivered, deliveries, requests: requests.length, toolResults, tools };
}

test('a valid record is committed with its attempt and ends the run: the model is asked nothing more', async () => {
  const { settled, record, gate, delivered, deliveries, requests, tools } = await run([submit({ verdict: 'buy', score: '7' }), say('never asked')]);
  assert.equal(settled.status, 'done');
  assert.deepEqual(record, { record: { verdict: 'buy', score: 7 }, attempts: 1 }, 'the stringified integer is repaired before the schema is held');
  assert.equal(gate, undefined, 'a record nobody disagreed with writes no gate document');
  assert.deepEqual(delivered, { record: { verdict: 'buy', score: 7 }, disagreements: [] });
  assert.deepEqual(deliveries, ['accepted']);
  assert.equal(requests, 1);
  const tool = tools.find((candidate) => candidate.name === 'submit');
  assert.equal(tool.description, 'Deliver the verdict record. Submit it inline as the tool arguments. It ends the run.');
  assert.deepEqual(tool.parameters, { type: 'object', additionalProperties: true, properties: { verdict: { type: 'string', description: 'buy or pass' }, score: { type: 'integer' } } }, 'the record\'s own fields, none required');
});

test('a rejection is told with its count and the run goes on; the next valid record is the record', async () => {
  const { record, deliveries, requests, toolResults } = await run([submit({ score: 3 }), submit({ verdict: 'pass' }), say('never asked')]);
  assert.deepEqual(record, { record: { verdict: 'pass' }, attempts: 2 });
  assert.deepEqual(deliveries, ['rejected', 'accepted']);
  assert.equal(requests, 2);
  assert.match(toolResults[1].at(-1), /^REJECTED \(1\/6\) — submission does not satisfy the schema: .+\. Fix exactly those and resubmit\.$/);
});

test('the second reading sends the first record back once and the next is delivered with the disagreement in the gate document', async () => {
  const { record, gate, delivered, deliveries, toolResults } = await run([submit({ verdict: 'hold' }), submit({ verdict: 'hold' }), say('never asked')],
    { reviewers: [(candidate) => candidate.verdict === 'buy' ? [] : [objection('names no buy')]] });
  assert.deepEqual(deliveries, ['bounced', 'accepted']);
  assert.equal(toolResults[1].at(-1), 'verify (verify): fails - names no buy');
  assert.deepEqual(record, { record: { verdict: 'hold' }, attempts: 2 });
  assert.deepEqual(gate, { bounced: true, disagreements: [objection('names no buy')] });
  assert.deepEqual(delivered.disagreements, [objection('names no buy')]);
});

test('past the delivery attempts the run ends with no record', async () => {
  const { settled, record, delivered, deliveries, requests, toolResults } = await run([submit({ nope: 1 }), submit({ nope: 2 }), submit({ verdict: 'buy' })], { maxAttempts: 2 });
  assert.deepEqual(deliveries, ['rejected', 'rejected']);
  assert.deepEqual(record, { record: null, attempts: 2 });
  assert.equal(delivered, undefined);
  assert.equal(requests, 2, 'the spent rejection ends the run');
  assert.equal(settled.status, 'done');
  assert.match(toolResults[1].at(-1), /^REJECTED \(1\/2\)/);
});

test('a yield with the record owed is nudged, each nudge one attempt; a record after a nudge is delivered', async () => {
  const { record, requests } = await run([say('I think buy.'), submit({ verdict: 'buy' })]);
  assert.deepEqual(record, { record: { verdict: 'buy' }, attempts: 2 }, 'the nudge and the delivery');
  assert.equal(requests, 2);
  const stuck = await run([say('thinking'), say('still thinking'), say('never asked'), say('never asked')], { maxAttempts: 2 });
  assert.deepEqual(stuck.record, { record: null, attempts: 2 });
  assert.equal(stuck.requests, 3, 'two nudges are the two attempts; the third yield is not nudged');
});

test('a nudge is never sent once a record is delivered, and a conversation that owes none is not nudged', async () => {
  const faux = fauxProvider();
  let requests = 0;
  faux.setResponses([() => { requests += 1; return say('done, no record owed'); }, () => { requests += 1; return say('never asked'); }]);
  const models = createModels();
  models.setProvider(faux.provider);
  let spent = 0;
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'record-test', hooks: [recordNudge({ label: () => undefined, spend: async () => { spent += 1; } })] }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const conversation = await harness.root(ctx, { agent: { model: MODEL } });
  await (await conversation.submit({ type: 'input', content: 'Chat.', requestId: 'chat' }, ctx)).wait(ctx);
  await harness.close(ctx);
  assert.deepEqual([requests, spent], [1, 0]);
});

test('a record delivered as a workspace file is read from inside the workspace only, fresh and parsed', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'record-file-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, 'out'));
  writeFileSync(join(workspace, 'out', 'record.json'), JSON.stringify({ verdict: 'buy', score: '9' }));
  writeFileSync(join(workspace, 'broken.json'), '{ not json');
  writeFileSync(join(workspace, 'old.json'), JSON.stringify({ verdict: 'old' }));
  utimesSync(join(workspace, 'old.json'), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  const outside = mkdtempSync(join(tmpdir(), 'record-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.json'), JSON.stringify({ verdict: 'leaked' }));
  symlinkSync(join(outside, 'secret.json'), join(workspace, 'link.json'));
  const started = Date.now();
  const file = workspaceRecordFile({ key: '_record_file', workspace, notBefore: () => started });
  assert.deepEqual(await file.read('out/record.json'), { verdict: 'buy', score: '9' });
  await assert.rejects(file.read('missing.json'), (error) => error.code === 'ENOENT');
  await assert.rejects(file.read('../escape.json'), /_record_file names a path outside the workspace: \.\.\/escape\.json/);
  await assert.rejects(file.read(join(outside, 'secret.json')), /_record_file must name a workspace-relative \.json file/);
  await assert.rejects(file.read('out/record.txt'), /_record_file must name a workspace-relative \.json file/);
  await assert.rejects(file.read('link.json'), /_record_file names a path outside the workspace through a symlink: link\.json/);
  await assert.rejects(file.read('out'), /must name a workspace-relative \.json file/);
  await assert.rejects(file.read('broken.json'), /_record_file is not valid JSON: /);
  await assert.rejects(file.read('old.json'), /_record_file is stale; write it during this run before submitting/);

  const pointed = await run([submit({ _record_file: 'out/record.json' }), say('never asked')], { file }, { fileKey: '_record_file' });
  assert.deepEqual(pointed.record, { record: { verdict: 'buy', score: 9 }, attempts: 1 });
  assert.equal(pointed.tools.find((tool) => tool.name === 'submit').description,
    'Deliver the verdict record. Submit it inline, or for a large record write JSON in the workspace and pass {"_record_file":"relative/path.json"}. It ends the run.');
  const stale = await run([submit({ _record_file: 'old.json' }), submit({ verdict: 'pass' }), say('never asked')], { file }, { fileKey: '_record_file' });
  assert.match(stale.toolResults[1].at(-1), /^REJECTED \(1\/6\) — submission does not satisfy the schema: _record_file is stale; write it during this run before submitting\. Fix exactly those and resubmit\.$/);
  assert.deepEqual(stale.record, { record: { verdict: 'pass' }, attempts: 2 });
});

test('an error the host claims ends the run with the host told; any other error is the tool\'s', async () => {
  const told = [];
  const claimed = Object.assign(new Error('the ledger refused a receipt'), { code: 'LEDGER' });
  const { record, requests, toolResults } = await run([submit({ verdict: 'buy' }), say('the run is over'), say('never asked')],
    { reviewers: [() => { throw claimed; }] },
    { fatal: (error) => error?.code === 'LEDGER', onFatal: (error) => told.push(error.message), fatalText: 'The run\'s ledger refused a receipt; the run stops.' });
  assert.deepEqual(told, ['the ledger refused a receipt']);
  assert.deepEqual(record ?? { record: null, attempts: 0 }, { record: null, attempts: 0 }, 'nothing was delivered');
  assert.equal(requests, 1, 'the claimed failure ends the run');
  assert.deepEqual(toolResults, [[]]);
});
