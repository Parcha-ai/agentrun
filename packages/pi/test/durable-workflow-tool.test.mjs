// The agentrun tool in a pi-durable session, over the in-memory storage with a scripted model that calls it: describe,
// inspect and the dry run as the coding-agent tool gives them, save, load and list on the project store the host
// names, and a run as one background task of the calling conversation. Each test counts the effects the host ran.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { compileTransform } from '@parcha/agentrun-dsl';
import { workspaceFiles } from '@parcha/agentrun-dsl/recovery';
import { createWorkflowTool } from '@parcha/agentrun-pi/durable';
import { WorkflowStore } from '@parcha/agentrun-pi/workflows';

const root = mkdtempSync(join(tmpdir(), 'agentrun-durable-tool-'));
after(() => rmSync(root, { recursive: true, force: true }));

const MODEL = { provider: 'faux', modelId: 'faux-1' };
const call = (args) => fauxAssistantMessage([fauxToolCall('agentrun', args)], { stopReason: 'toolUse' });
const say = (text) => fauxAssistantMessage(text);
const QUOTE = { name: 'prices.quote', description: 'Quote a fictional SKU.', parameters: { type: 'object', additionalProperties: false, required: ['sku'], properties: { sku: { type: 'string' } } } };
const schemas = {
  Input: { type: 'object', additionalProperties: false, required: ['sku'], properties: { sku: { type: 'string' } } },
  Quote: { type: 'object', additionalProperties: false, required: ['price'], properties: { price: { type: 'number' } } },
  Out: { type: 'object', additionalProperties: false, required: ['total'], properties: { total: { type: 'number' } } },
};
const quote = { node: 'call', label: 'quote', via: 'tool', tool: 'prices.quote', args: { sku: '{sku}' }, out: 'Quote', as: 'quote', deadline_s: 20 };
/** A quote and nothing else: no code. */
const QUOTED = { v: 2, name: 'quoted', schemas, input: { schemaId: 'Input' }, output: { schemaId: 'Quote', path: 'quote' }, root: quote };
/** A quote, then code that doubles it. */
const DOUBLED = { v: 2, name: 'doubled', schemas, input: { schemaId: 'Input' }, output: { schemaId: 'Out', path: 'result' },
  root: { node: 'chain', steps: [quote, { node: 'code', label: 'total', code: 's => ({ result: { total: s.quote.price * 2 } })' }] } };
/** An input schema the generator cannot satisfy. */
const PATTERNED = { ...QUOTED, name: 'patterned', schemas: { ...schemas, Input: { ...schemas.Input, properties: { sku: { type: 'string', pattern: '^[A-Z]-[0-9]+$' } } } } };
/** The host's executor for code, as a trusted host would run it. */
const runCode = async (node, state, at) => compileTransform(node.code)(state, { sop: at.sop });

/** A Harness with the tool's extension, a root conversation that offers it, and what the model was sent. */
async function rig(turns, host = {}) {
  const requests = [];
  const faux = fauxProvider();
  faux.setResponses(turns.map((turn) => async (context) => { requests.push(JSON.parse(JSON.stringify(context.messages))); return turn; }));
  const models = createModels();
  models.setProvider(faux.provider);
  const projectDir = mkdtempSync(join(root, 'project-'));
  const files = workspaceFiles(mkdtempSync(join(root, 'cwd-')));
  const effects = [];
  const tool = createWorkflowTool({
    projectDir, tools: [QUOTE],
    task: { options: () => ({ files }), run: () => ({ adapters: { runEffect: async (params) => { effects.push(params.node.tool); return { price: 21 }; } } }) },
    ...host,
  });
  const registry = createRegistry();
  registry.install(tool.extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const conversation = await harness.root(ctx, { agent: { model: MODEL, extensions: [tool.extension] } });
  let asked = 0;
  const ask = async (content) => (await (await conversation.submit({ type: 'input', content, requestId: `ask-${++asked}` }, ctx)).wait(ctx));
  /** The tool's answers the model read, in order, as text. */
  const answers = () => requests.at(-1).filter((message) => message.role === 'toolResult').map((message) => message.content.map((block) => block.text ?? '').join(''));
  return { harness, conversation, ask, answers, requests, effects, projectDir };
}

test('describe lists the host\'s tools and the durable host\'s rules; inspect keeps the draft; its dry run calls no tool', async () => {
  const { harness, ask, answers, requests, effects } = await rig([call({ action: 'describe' }), call({ action: 'inspect', workflow: QUOTED }), call({ action: 'dry-run' }), say('done')]);
  await ask('Check the quote workflow.');
  assert.equal(requests.length, 4);
  const [described, inspected, dried] = answers().map((text) => JSON.parse(text));
  assert.deepEqual(described.tools.map((t) => t.name), ['prices.quote']);
  assert.match(described.authoring.host, /pi-durable/);
  assert.match(described.authoring.language, /node/);
  assert.equal(inspected.workflow.name, 'quoted');
  assert.match(inspected.preview, /quote/);
  assert.equal(dried.dryRun.status, 'passed');
  assert.deepEqual(effects, [], 'a dry run calls no tool');
  await harness.close(ctx);
});

test('a draft whose schema the generator cannot synthesize is not run, never passed; code is not run without the host\'s executor', async () => {
  const { harness, ask, answers, effects } = await rig([
    call({ action: 'inspect', workflow: PATTERNED }), call({ action: 'dry-run' }),
    call({ action: 'inspect', workflow: DOUBLED }), call({ action: 'dry-run' }), call({ action: 'run', input: { sku: 'A-1' } }), say('done')]);
  await ask('Check both.');
  const [, patterned, , doubled, refused] = answers();
  assert.equal(JSON.parse(patterned).dryRun.status, 'not_run');
  assert.match(JSON.parse(patterned).dryRun.skipped.join('\n'), /pattern/);
  assert.equal(JSON.parse(doubled).dryRun.status, 'not_run');
  assert.match(JSON.parse(doubled).dryRun.skipped.join('\n'), /"total".*host's code executor/);
  assert.match(refused, /code/i);
  assert.deepEqual(effects, [], 'neither the dry runs nor the refused run called a tool');
  await harness.close(ctx);
});

test('with the host\'s code executor, the code draft dry-runs and runs as one background task of the calling conversation', async () => {
  const { harness, conversation, ask, answers, effects } = await rig([
    call({ action: 'inspect', workflow: DOUBLED, input: { sku: 'A-1' } }), call({ action: 'dry-run' }), call({ action: 'run' }), call({ action: 'run' }), say('done')], { runCode });
  await ask('Run it.');
  const [, dried, ran, again] = answers();
  assert.equal(JSON.parse(dried).dryRun.status, 'passed');
  assert.deepEqual(effects, ['prices.quote'], 'the run made the call once; the dry run made none');
  const { run, outcome, progress } = JSON.parse(ran);
  assert.equal(outcome.status, 'complete');
  assert.deepEqual(outcome.output, { total: 42 });
  assert.match(progress.join('\n'), /2 succeeded · 0 active · 0 failed/);
  const task = await harness.getTask(run.taskId, ctx);
  assert.equal(task.state.status, 'terminal');
  assert.equal(task.input.key, run.key);
  assert.equal(task.kind, 'agentrun.workflow');
  assert.equal(Number(task.conversationId), Number(conversation.id), 'a task of the calling conversation');
  assert.equal(task.background, true);
  const second = JSON.parse(again);
  assert.deepEqual([second.run.started, second.run.taskId, second.outcome.output], ['settled', run.taskId, { total: 42 }], 'the same draft and input reach the same run');
  assert.deepEqual(effects, ['prices.quote'], 'and make no effect again');
  await harness.close(ctx);
});

test('save, list and load use the store in the project the host names, the records the coding-agent extension reads', async () => {
  const { harness, ask, answers, projectDir } = await rig([
    call({ action: 'inspect', workflow: QUOTED }), call({ action: 'save', name: 'quote-flow' }), call({ action: 'list' }),
    call({ action: 'inspect', workflow: PATTERNED }), call({ action: 'load', name: 'quote-flow' }), call({ action: 'dry-run' }), say('done')]);
  await ask('Keep it.');
  const [, saved, listed, , loaded, dried] = answers().map((text) => JSON.parse(text));
  assert.equal(saved.name, 'quote-flow');
  assert.deepEqual(listed.workflows.map((w) => w.name), ['quote-flow']);
  assert.equal(loaded.workflow.name, 'quoted');
  assert.equal(dried.dryRun.status, 'passed', 'the loaded draft replaced the patterned one');
  const stored = await new WorkflowStore(projectDir).list();
  assert.deepEqual(stored.map((w) => [w.name, w.digest]), [['quote-flow', saved.digest]]);
  await harness.close(ctx);
});
