// The web example's agent app, offline: no network, no key, no model call. Runs are started in a real agent home with
// @parcha/pi-durable-agent, a run's Harness is opened on its store with the options the app returns, and its root
// conversation is created the way the serve door creates it, after the app's `beforeResume`.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { carryBack, readAgentHome, startRun } from '@parcha/pi-durable-agent';
import { createAgent, liveOf, PROFILE, promptOf, signInAsked, toolsOf } from './app.ts';
import { ensureAgentHome } from './home.mjs';

const ENV = { BROWSERBASE_API_KEY: 'unused', AGENT_MODEL_BASE_URL: 'http://127.0.0.1:9/v1', AGENT_MODEL: 'test-model' };

async function agentHome(t) {
  const tmp = await mkdtemp(join(tmpdir(), 'web-agent-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  return { tmp, home: await ensureAgentHome(join(tmp, 'home')) };
}

/** Run `runId` started in `home`, as pi-durable-disk hands it to the app. */
async function started(home, runId) {
  const run = await startRun(home, { runId, host: 'test' });
  return { run, where: { ref: { disk: 'local', region: 'local', id: runId }, root: run.dir, work: run.workspace, store: dirname(run.storePath) } };
}

/** The app's options on the run's own store, `beforeResume` included, as pi-durable-disk opens a run. */
async function open(t, run, options) {
  const harness = await Harness.open(await openNodeSqliteStorage(run.storePath), { models: options.models, registry: options.registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx).catch(() => {}));
  await options.beforeResume({ harness, context: ctx });
  return harness;
}

test('the home is made from agent.json and the skills: the definition names no model, and the prompt carries each skill in order', async (t) => {
  const { tmp, home } = await agentHome(t);
  const state = await readAgentHome(home);
  assert.equal(state.identity.id, 'site-reporter');
  assert.deepEqual(Object.keys(state.skills).sort(), ['sign-in/SKILL.md', 'site-report/SKILL.md']);
  const prompt = promptOf(state);
  assert.ok(prompt.indexOf('<skill name="sign-in">') < prompt.indexOf('<skill name="site-report">'), 'skills follow the definition order');
  assert.equal((await stat(home.dir)).mode & 0o777, 0o700, 'the home holds sign-ins: owner only');

  const agentDir = join(tmp, 'agent');
  await cp(import.meta.dirname, agentDir, { recursive: true, filter: (from) => !from.endsWith('.test.mjs') });
  const good = JSON.parse(await readFile(join(agentDir, 'agent.json'), 'utf8'));
  await writeFile(join(agentDir, 'agent.json'), JSON.stringify({ ...good, model: 'any' }));
  await assert.rejects(ensureAgentHome(join(tmp, 'other'), agentDir), /fields it does not keep: model/);
  assert.throws(() => toolsOf({ tools: ['read', 'bash'] }, { coding: [{ name: 'read' }] }), /names the tool bash/);
  assert.throws(() => promptOf({ definition: { ...state.definition, skills: ['missing'] }, skills: {} }), /no missing\/SKILL\.md/);
});

test('run 1 makes the browser profile once, the root conversation carries it, and carryBack gives it to run 2, which makes none', async (t) => {
  const { home } = await agentHome(t);
  let made = 0;
  const makeContext = async () => (made++, 'ctx-made-by-run-1');

  const one = await started(home, 'run-1');
  const { options, browser } = await createAgent(one.where, ENV, { makeContext });
  const harness = await open(t, one.run, options);
  const root = await harness.root(ctx, options.root);
  const config = await harness.snapshot(browser.docs.Config, root.id, ctx);
  assert.deepEqual([made, config.run, config.policy.contextId, config.policy.idleReleaseS], [1, 'run-1', 'ctx-made-by-run-1', 900]);
  const agent = await root.agent(ctx);
  assert.deepEqual(agent.tools.map((tool) => tool.name), ['read', 'write', 'edit', 'snapshot', 'run', 'browser_read', 'browser_release', 'request_sign_in']);
  assert.deepEqual([agent.model, agent.thinkingLevel], [{ provider: 'agent-model', modelId: 'test-model' }, 'medium']);
  assert.doesNotMatch(agent.instructions, /ctx-made-by-run-1/, 'the context id never reaches the model');
  await harness.close(ctx);
  assert.deepEqual((await carryBack(home, one.run, { outcome: 'completed' })).profiles, [PROFILE]);
  assert.equal((await readAgentHome(home)).profiles[PROFILE].ref, 'ctx-made-by-run-1');

  const two = await started(home, 'run-2');
  assert.deepEqual(two.run.leases, [PROFILE], 'run 2 holds the save lease');
  const second = await createAgent(two.where, ENV, { makeContext: async () => assert.fail('run 2 starts signed in: it makes no profile') });
  const harness2 = await open(t, two.run, second.options);
  const root2 = await harness2.root(ctx, second.options.root);
  assert.equal((await harness2.snapshot(second.browser.docs.Config, root2.id, ctx)).policy.contextId, 'ctx-made-by-run-1');
  assert.equal(made, 1);
});

test('the root conversation is never created before the profile is resolved', async (t) => {
  const { home } = await agentHome(t);
  const one = await started(home, 'run-1');
  const { options } = await createAgent(one.where, ENV, { makeContext: async () => 'ctx-1' });
  const harness = await Harness.open(await openNodeSqliteStorage(one.run.storePath), { models: options.models, registry: options.registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx).catch(() => {}));
  await assert.rejects(harness.root(ctx, options.root), /resolved before the root conversation/);
});

test('request_sign_in ends the turn: no model request and no tool runs until the person replies', async (t) => {
  const { home } = await agentHome(t);
  const one = await started(home, 'run-1');
  const { options } = await createAgent(one.where, ENV, { makeContext: async () => 'ctx-1' });
  let asked = 0;
  const faux = fauxProvider({ models: [{ id: 'scripted' }] });
  faux.setResponses([
    () => (asked++, fauxAssistantMessage([fauxToolCall('request_sign_in', { site: 'the practice site', reason: 'The secure page needs a sign-in.' }, { id: 'call-1' })], { stopReason: 'toolUse' })),
    () => (asked++, fauxAssistantMessage([fauxText('this answer must never be asked for')], { stopReason: 'stop' })),
  ]);
  options.models.setProvider(faux.provider);
  const harness = await open(t, one.run, options);
  const root = await harness.root(ctx, { ...options.root, agent: { ...options.root.agent, model: { provider: faux.provider.id, modelId: 'scripted' } } });
  const settled = await (await root.submit({ type: 'input', content: 'Log in and report.', requestId: 'ask-1' }, ctx)).wait(ctx);

  assert.equal(settled.status, 'done');
  assert.equal(asked, 1, 'the run ended on the tool result, without another model request');
  const newest = (await root.entries({}, 1, undefined, ctx)).items[0];
  assert.equal(newest.kind, 'pi.tool-result');
  assert.deepEqual(newest.model[0].content, [{ type: 'text', text: signInAsked('the practice site') }]);
});

test('thinking is never off, and the model and the key come from the host', async (t) => {
  const { home } = await agentHome(t);
  const { where } = await started(home, 'run-1');
  await assert.rejects(createAgent(where, { ...ENV, AGENT_THINKING: 'off' }), /thinking is never off/);
  await assert.rejects(createAgent(where, { ...ENV, AGENT_MODEL: '' }), /AGENT_MODEL/);
  await assert.rejects(createAgent(where, { ...ENV, BROWSERBASE_API_KEY: '' }), /BROWSERBASE_API_KEY/);
});

test('live.json shows the live view while the session is open and nothing once it is released', () => {
  const row = { conversationId: 1, label: 'site-reporter', session: { resourceId: 'session-1' }, liveView: { fullscreen: 'https://live.example/full?t=x', framed: 'https://live.example/framed?t=x', pages: [] } };
  const at = new Date('2026-10-15T21:00:00Z');
  assert.deepEqual(liveOf(row, 'launched', at), { liveViewUrl: 'https://live.example/full?t=x', sessionId: 'session-1', change: 'launched', updatedAt: '2026-10-15T21:00:00.000Z' });
  assert.deepEqual(liveOf(row, 'released', at), { liveViewUrl: null, sessionId: 'session-1', change: 'released', updatedAt: '2026-10-15T21:00:00.000Z' });
  assert.equal(liveOf({ ...row, liveView: null }, 'updated', at).liveViewUrl, null);
});
