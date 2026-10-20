// The v4 models at $0: Opus for the root agent at high thinking, the host's cheap model for every workflow agent node
// whatever the workflow asks, each conversation priced by its own model, Opus's route through a fake gateway, and the
// self-test's record of both models.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { recordingLines } from '@parcha/agentrun-pi/durable';
import { agentHomeFor, jobInput, meteredJudge, prepareRun, runJob } from './host.mjs';
import { jobRecordOf } from './job-record.mjs';
import { gatewayModels, NODE, NODE_MODELS, PRICES, ROOT } from './models.mjs';
import { openOut, scriptedParts } from './runner.mjs';
import { FIXTURES, fixtureFetch, readJson, scriptedJev, scriptedModel } from './scripted.mjs';
import { passSelfTest } from './selftest.mjs';
import { SETS } from './sets.mjs';
import { answerV1, sic2GroupsTool } from './host.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'learn-models-test-'));
  await chmod(dir, 0o755);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const near = (a, b) => Math.abs(a - b) < 1e-12;

test('the root agent runs Opus at high thinking; every workflow agent node runs the host\'s cheap model; one line switches it', async () => {
  const gateway = { root: 'http://127.0.0.1:9/gw', key: 'gateway-placeholder' };
  assert.deepEqual(ROOT, { model: 'claude-opus-5-5', thinking: 'high' });
  assert.equal(NODE, NODE_MODELS.luna);
  const { models, agent, node } = await gatewayModels(gateway);
  assert.deepEqual(agent, { model: { provider: 'gateway', modelId: 'claude-opus-5-5' }, thinkingLevel: 'high' });
  assert.deepEqual(node, { model: { provider: 'gateway', modelId: 'gpt-6-luna' }, thinkingLevel: 'medium' });
  const opus = models.getModel('gateway', 'claude-opus-5-5');
  assert.equal(opus.api, 'anthropic-messages');
  assert.equal(opus.baseUrl, gateway.root, 'the Messages client adds /v1/messages to the gateway\'s root');
  assert.deepEqual({ ...opus.cost }, { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 });
  const luna = models.getModel('gateway', 'gpt-6-luna');
  assert.equal(luna.api, 'openai-responses');
  assert.equal(luna.baseUrl, `${gateway.root}/v1`);
  assert.deepEqual({ ...luna.cost }, { input: 0.1, output: 0.5, cacheRead: 0.1, cacheWrite: 0.1 });

  const cheap = await gatewayModels(gateway, { node: NODE_MODELS.deepseek });
  assert.deepEqual(cheap.node, { model: { provider: 'gateway', modelId: 'deepseek-v4.1-flash' }, thinkingLevel: 'high' });
  const deepseek = cheap.models.getModel('gateway', 'deepseek-v4.1-flash');
  assert.equal(deepseek.api, 'openai-completions');
  assert.deepEqual({ input: deepseek.cost.input, output: deepseek.cost.output }, { input: 0.22, output: 0.66 });
  assert.equal(deepseek.thinkingLevelMap[cheap.node.thinkingLevel], 'high', 'deepseek thinks at the level the host sets');

  await assert.rejects(gatewayModels(gateway, { node: { model: 'gpt-6-luna', thinking: 'off' } }), /thinking is never off/);
  await assert.rejects(gatewayModels(gateway, { root: { model: 'claude-opus-5-5' } }), /thinking is never off/);
  await assert.rejects(gatewayModels(gateway, { node: { model: 'some-unpriced-model', thinking: 'low' } }), /no price for some-unpriced-model/);
});

test('Opus goes through the gateway\'s Messages API at its root, thinking high, with the gateway\'s key, priced at Opus\'s rates', async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!req.headers['x-api-key'] && !req.headers.authorization) { res.writeHead(404); return res.end(); }
      seen.push({ path: req.url, key: req.headers['x-api-key'] ?? req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      event('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 2000 } } });
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 500 } });
      event('message_stop', {});
      res.end();
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const gateway = { root: `http://127.0.0.1:${server.address().port}`, key: 'gateway-placeholder' };
  const { models, agent } = await gatewayModels(gateway);
  const opus = models.getModel('gateway', agent.model.modelId);
  const answer = await models.completeSimple(opus, { messages: [{ role: 'user', content: 'Say ok.', timestamp: Date.now() }] }, { reasoning: agent.thinkingLevel });
  assert.equal(answer.stopReason, 'stop', answer.errorMessage);
  assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0].path, 'http://x').pathname, '/v1/messages');
  assert.match(seen[0].key, /gateway-placeholder/);
  assert.equal(seen[0].body.model, 'claude-opus-5-5');
  assert.equal(seen[0].body.thinking?.type, 'adaptive');
  assert.equal(seen[0].body.output_config?.effort, 'high', JSON.stringify(seen[0].body.output_config));
  const u = answer.usage;
  assert.ok(near(u.cost.total, (u.input * 4 + u.output * 20 + u.cacheRead * 0.4 + u.cacheWrite * 5) / 1e6), JSON.stringify(u));
  assert.ok(u.cost.total > 0);
});

test('a run puts every workflow agent node on the host\'s model and level, whatever the workflow asks, and prices each conversation by its own model', async (t) => {
  const out = join(await scratch(t), 'out');
  const { repo } = await openOut(out, { mode: 'scripted' });
  const home = await agentHomeFor({ dir: join(out, 'home'), repo });
  const labels = readJson(join(FIXTURES, 'sic2.json'));
  const job = readJson(join(FIXTURES, 'companies.json'))[0];
  const run = await prepareRun({ home, repo, host: 'test', runId: 'run-models', input: jobInput(job) });
  const workflow = {
    v: 2, name: 'node-model',
    schemas: { Company: { type: 'object' }, Done: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'string' } } } },
    input: { schemaId: 'Company' },
    output: { schemaId: 'Done', path: 'done' },
    root: { node: 'agent', label: 'asks for more', tier: 'strong', thinking: 'high', instructions: 'Deliver ok.', state: { website: '{website}' }, out: 'Done', as: 'done' },
  };
  const model = scriptedModel({
    root: [
      { call: 'agentrun', args: { action: 'inspect', workflow, input: jobInput(job) } },
      { call: 'agentrun', args: { action: 'run' } },
      { say: 'Done.' },
    ],
    node: () => ({ submit: { ok: 'ok' } }),
    models: { root: { id: 'claude-opus-5-5', thinking: 'high', cost: PRICES['claude-opus-5-5'] }, node: { id: 'gpt-6-luna', thinking: 'medium', cost: PRICES['gpt-6-luna'] } },
  });
  const measure = await runJob({ run, job, model, judge: meteredJudge(scriptedJev()), effects: [fixtureFetch({}), sic2GroupsTool(labels)], answer: answerV1(labels) });
  assert.equal(measure.workflowRuns[0]?.outcome, 'complete', JSON.stringify(measure.workflowRuns));
  const by = (who) => [...new Set(model.seen.filter((r) => r.who === who).map((r) => `${r.model} ${r.thinking}`))];
  assert.deepEqual(by('root'), ['claude-opus-5-5 high']);
  assert.deepEqual(by('node'), ['gpt-6-luna medium'], 'the workflow asked for the strong tier at high; the host\'s node model and level won');

  // Each conversation's usage is its own model's, priced at that model's rates.
  const { lines } = recordingLines(run.storePath);
  const latest = new Map();
  for (const line of lines) if (line.kind === 'pi.usage') latest.set(line.conv, line.data?.value);
  const priced = { 'claude-opus-5-5': PRICES['claude-opus-5-5'], 'gpt-6-luna': PRICES['gpt-6-luna'] };
  const perModel = {};
  for (const usage of latest.values()) {
    for (const [key, u] of Object.entries(usage?.models ?? {})) {
      const id = Object.keys(priced).find((name) => key.endsWith(name));
      assert.ok(id, `a conversation used ${key}`);
      const p = priced[id];
      assert.ok(near(u.cost.total, (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6), `${key} priced at its own rates`);
      perModel[id] = (perModel[id] ?? 0) + u.cost.total;
    }
  }
  assert.ok(perModel['claude-opus-5-5'] > 0 && perModel['gpt-6-luna'] > 0, JSON.stringify(perModel));
  // The row's cost is every conversation's; the execution's is its node's alone, at Luna's rates.
  assert.ok(near(measure.usage.costUsd, perModel['claude-opus-5-5'] + perModel['gpt-6-luna']));
  const [execution] = jobRecordOf(lines).executions;
  assert.ok(near(execution.costUsd, perModel['gpt-6-luna']), JSON.stringify(execution));
});

test('the self-test records both models and stops a pass whose workflow agent nodes would run Opus', async (t) => {
  const root = await scratch(t);
  const base = scriptedParts({ set: SETS.v1 });
  const withNode = (node) => ({
    ...base,
    mode: 'live',
    modelFor: (job, run) => {
      const job1 = base.modelFor(job, run);
      return { ...job1, agent: { model: { provider: 'faux', modelId: 'claude-opus-5-5' }, thinkingLevel: 'high' }, node: { model: { provider: 'faux', modelId: node }, thinkingLevel: 'medium' } };
    },
  });
  const ok = join(root, 'ok');
  const { repo } = await openOut(ok, { mode: 'live' });
  const report = await passSelfTest({ out: ok, repo, parts: withNode('gpt-6-luna') });
  assert.deepEqual({ root: report.models.root, node: report.models.node }, { root: { model: 'claude-opus-5-5', thinking: 'high' }, node: { model: 'gpt-6-luna', thinking: 'medium' } });
  assert.deepEqual(report.models.nodeRequests, ['gpt-6-luna medium']);
  assert.deepEqual(report.models.rootRequests, ['claude-opus-5-5 high']);
  assert.deepEqual(JSON.parse(await readFile(join(ok, 'selftest.json'), 'utf8')).models.node, { model: 'gpt-6-luna', thinking: 'medium' });

  const bad = join(root, 'bad');
  const { repo: badRepo } = await openOut(bad, { mode: 'live' });
  await assert.rejects(passSelfTest({ out: bad, repo: badRepo, parts: withNode('claude-opus-5-5') }), /workflow agent nodes would run claude-opus-5-5/);
  const unnamed = { ...withNode('gpt-6-luna'), modelFor: (job, run) => ({ ...base.modelFor(job, run), node: undefined }) };
  await assert.rejects(passSelfTest({ out: bad, repo: badRepo, parts: unnamed }), /names no model for workflow agent nodes/);
});
