// A node's configuration document carries its input: the prompt state the interpreter stringified into the node's user
// text, as JSON, so a reader shows what a node was given without parsing its prompt. A user text that is not a JSON
// object leaves the document without it. A document an older build wrote has no input, and a run that build started
// resumes on it as it is.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { runWorkflow } from '@parcha/agentrun-dsl';
import { hostScope } from '../dist/durable/node.js';
import { NodeDoc, nodeRunner } from '../dist/durable/node-runner.js';
import { childPath } from './fixtures/cross-version.mjs';

const MODEL = { provider: 'faux', modelId: 'faux-1' };
const VERDICT = { type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' } } };
const SCORE = { type: 'object', additionalProperties: false, required: ['score'], properties: { score: { type: 'integer' } } };
const OLDER_KEYS = ['fileKey', 'label', 'schema', 'system'];
const submit = (args) => fauxAssistantMessage([fauxToolCall('submit', args)], { stopReason: 'toolUse' });
/** A user turn's text, whether pi was given one string or text parts. */
const userText = (messages) => {
  const { content } = messages.find((message) => message.role === 'user');
  return typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('\n');
};

async function rig(turns) {
  const requests = [];
  const faux = fauxProvider();
  faux.setResponses(turns.map((turn) => async (context) => { requests.push(JSON.parse(JSON.stringify(context.messages))); return turn; }));
  const models = createModels();
  models.setProvider(faux.provider);
  const opened = [];
  const nodes = nodeRunner({ agent: () => ({ model: MODEL }), onNodeOpen: (node) => { opened.push(node.conversationId); } });
  const registry = createRegistry();
  registry.install(nodes.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  return { harness, requests, opened, ...nodes.on(hostScope(harness), ctx) };
}

test('each node\'s document carries its prompt state as JSON, the value its user text begins with', async () => {
  const { harness, runNode, requests, opened } = await rig([submit({ verdict: 'buy' }), submit({ score: 7 })]);
  const workflow = { v: 2, name: 'two-nodes', schemas: { Verdict: VERDICT, Score: SCORE, Out: { type: 'object', required: ['verdict'], properties: { verdict: { type: 'string' } } } },
    output: { schemaId: 'Out', path: 'decision' }, root: { node: 'chain', steps: [
      { node: 'decide', label: 'Verdict', instructions: 'Decide buy or pass.', out: 'Verdict', as: 'decision' },
      { node: 'extract', label: 'Score', instructions: 'Score it.', out: 'Score', as: 'score' },
    ] } };
  const input = { claim: 'x', facts: { price: 12.5, tags: ['a', 'b'], seller: null } };
  const result = await runWorkflow(workflow, input, { runNode });
  assert.deepEqual(result.output, { verdict: 'buy' });
  assert.equal(opened.length, 2);
  const docs = await Promise.all(opened.map((id) => harness.snapshot(NodeDoc, id, ctx)));
  assert.deepEqual(docs.map((doc) => doc.input), [input, { ...input, decision: { verdict: 'buy' } }], 'each node\'s own prompt state: the second sees the first one\'s record');
  for (const [at, doc] of docs.entries()) assert.ok(userText(requests[at]).startsWith(`${JSON.stringify(doc.input)}\n`), 'the input is the value the user text was stringified from');
  assert.deepEqual(docs.map((doc) => [doc.label, doc.schema]), [['the Verdict record', VERDICT], ['the Score record', SCORE]], 'the rest of the document is as before');
  await harness.close(ctx);
});

test('a user text that is not a JSON object leaves the document as an older build wrote it', async () => {
  const { harness, runNode, opened } = await rig([submit({ verdict: 'buy' }), submit({ verdict: 'pass' })]);
  const node = (user, at) => ({ kind: 'decide', label: 'Verdict', executionPath: `/root/steps/${at}`, system: ['Decide buy or pass.'], user, schema: VERDICT });
  assert.deepEqual(await runNode(node('Write the workflow.\nAvailable input keys: ["claim"]', 0)), { verdict: 'buy' });
  assert.deepEqual(await runNode(node('["claim"]', 1)), { verdict: 'pass' });
  for (const id of opened) assert.deepEqual(Object.keys(await harness.snapshot(NodeDoc, id, ctx)).sort(), OLDER_KEYS);
  await harness.close(ctx);
});

test('a run an older build started, killed inside the model request, resumes on its document without input', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'node-doc-input-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'requests'), '');
  const child = (mode) => {
    const ran = spawnSync(process.execPath, [childPath('node-doc-input-child.mjs'), mode, join(dir, 'run.sqlite'), join(dir, 'requests')], { encoding: 'utf8', timeout: 60_000 });
    const rows = ran.stdout.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    return { signal: ran.signal, status: ran.status, stderr: ran.stderr, rows, events: rows.map((row) => row.event) };
  };
  const older = child('older');
  assert.equal(older.signal, 'SIGKILL', older.stderr);
  assert.deepEqual(older.events, ['open', 'request']);
  assert.deepEqual(Object.keys(older.rows[0].doc).sort(), OLDER_KEYS, 'the stored document is what the older build wrote');
  const resumed = child('resume');
  assert.equal(resumed.status, 0, resumed.stderr || `no end: ${JSON.stringify(resumed.rows)}`);
  assert.deepEqual(resumed.events, ['reached', 'open', 'request', 'end']);
  const open = resumed.rows.find((row) => row.event === 'open');
  assert.deepEqual([open.conversation, open.resumed], [older.rows[0].conversation, true], 'the same conversation, resumed');
  const end = resumed.rows.find((row) => row.event === 'end');
  assert.deepEqual(end.record, { verdict: 'buy' });
  assert.deepEqual(end.doc, older.rows[0].doc, 'the older document is read as it is, and not written again');
  assert.deepEqual(end.stored, { record: { verdict: 'buy' }, attempts: 1 });
  assert.equal(readFileSync(join(dir, 'requests'), 'utf8').split('\n').filter(Boolean).length, 2);
});
