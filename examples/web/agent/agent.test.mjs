// The web example's agent app, offline: no network, no key, no model call. A run's Harness is opened on a temporary
// store with the options the app returns, and its root conversation is created the way the serve door creates it.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Harness } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createAgent, liveOf, loadDefinition, promptOf, saveSignIn, loadSignIn, toolsOf } from './app.ts';

const CONTEXT_ID = 'ctx-saved-by-run-1';

async function place(t) {
  const tmp = await mkdtemp(join(tmpdir(), 'web-agent-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const root = join(tmp, 'runs', 'run-1');
  await mkdir(join(root, 'work'), { recursive: true });
  const env = { BROWSERBASE_API_KEY: 'unused', AGENT_MODEL_BASE_URL: 'http://127.0.0.1:9/v1', AGENT_MODEL: 'test-model', AGENT_HOME: join(tmp, 'home') };
  return { tmp, env, where: { ref: { disk: 'local', region: 'local', id: 'run-1' }, root, work: join(root, 'work'), store: join(root, 'store') } };
}

test('the definition carries the v2 names and no model, and every skill and tool it names exists', async () => {
  const definition = await loadDefinition();
  assert.deepEqual(Object.keys(definition).sort(), ['description', 'id', 'input_schema', 'instructions', 'max_cost_usd', 'name', 'output_schema', 'skills', 'tools', 'version', 'workflow']);
  const prompt = await promptOf(definition);
  for (const skill of definition.skills) assert.match(prompt, new RegExp(`<skill name="${skill}">`));
  assert.ok(prompt.indexOf('<skill name="sign-in">') < prompt.indexOf('<skill name="site-report">'), 'skills follow the definition order');
});

test('a definition that names a model, or a tool the host does not have, is refused', async (t) => {
  const { tmp } = await place(t);
  const dir = join(tmp, 'agent');
  await cp(import.meta.dirname, dir, { recursive: true, filter: (from) => !from.endsWith('.test.mjs') });
  const good = JSON.parse(await readFile(join(dir, 'agent.json'), 'utf8'));
  await writeFile(join(dir, 'agent.json'), JSON.stringify({ ...good, model: 'any' }));
  await assert.rejects(loadDefinition(dir), /names no model/);
  await writeFile(join(dir, 'agent.json'), JSON.stringify({ ...good, tools: ['read', 'bash'] }));
  assert.throws(() => toolsOf({ ...good, tools: ['read', 'bash'] }, { coding: [{ name: 'read' }] }), /names the tool bash/);
  await writeFile(join(dir, 'agent.json'), JSON.stringify({ ...good, skills: ['sign-in', 'missing'] }));
  await assert.rejects(promptOf(await loadDefinition(dir), dir), /skills\/missing\.md is missing/);
});

test('the root conversation is created with the prompt, the tools and the saved sign-in in its creating commit', async (t) => {
  const { tmp, env, where } = await place(t);
  await saveSignIn(env.AGENT_HOME, { contextId: CONTEXT_ID });
  const { options, browser } = await createAgent(where, env);
  const harness = await Harness.open(await openNodeSqliteStorage(join(tmp, 'run.sqlite')), { models: options.models, registry: options.registry, onReport: () => {} }, ctx);
  t.after(() => harness.close(ctx));
  const root = await harness.root(ctx, options.root);

  const config = await harness.snapshot(browser.docs.Config, root.id, ctx);
  assert.equal(config.run, 'run-1');
  assert.equal(config.policy.contextId, CONTEXT_ID);
  assert.equal(config.policy.idleReleaseS, 900, 'a person has time to sign in while the turn has ended');

  const agent = await root.agent(ctx);
  assert.deepEqual(agent.tools.map((tool) => tool.name), ['read', 'write', 'edit', 'snapshot', 'run', 'screenshot', 'browser_read', 'browser_release', 'browser_relaunch']);
  assert.deepEqual(agent.model, { provider: 'agent-model', modelId: 'test-model' });
  assert.equal(agent.thinkingLevel, 'medium');
  assert.match(agent.instructions, /<skill name="sign-in">/);
  assert.doesNotMatch(agent.instructions, new RegExp(CONTEXT_ID), 'the context id never reaches the model');
});

test('thinking is never off, and the model comes from the host', async (t) => {
  const { env, where } = await place(t);
  await saveSignIn(env.AGENT_HOME, { contextId: CONTEXT_ID });
  await assert.rejects(createAgent(where, { ...env, AGENT_THINKING: 'off' }), /thinking is never off/);
  await assert.rejects(createAgent(where, { ...env, AGENT_MODEL: '' }), /AGENT_MODEL/);
  await assert.rejects(createAgent(where, { ...env, BROWSERBASE_API_KEY: '' }), /BROWSERBASE_API_KEY/);
});

test('a sign-in is saved once, readable by its owner only', async (t) => {
  const { env } = await place(t);
  assert.equal(await loadSignIn(env.AGENT_HOME), null);
  assert.deepEqual(await saveSignIn(env.AGENT_HOME, { contextId: 'first' }), { contextId: 'first' });
  assert.deepEqual(await saveSignIn(env.AGENT_HOME, { contextId: 'second' }), { contextId: 'first' }, 'a racing run keeps the sign-in that landed first');
  assert.equal((await stat(join(env.AGENT_HOME, 'browser.json'))).mode & 0o777, 0o600);
});

test('live.json shows the live view while the session is open and nothing once it is released', () => {
  const row = { conversationId: 1, label: 'site-reporter', session: { resourceId: 'session-1' }, liveView: { fullscreen: 'https://live.example/full?t=x', framed: 'https://live.example/framed?t=x', pages: [] } };
  const at = new Date('2026-10-15T21:00:00Z');
  assert.deepEqual(liveOf(row, 'launched', at), { liveViewUrl: 'https://live.example/full?t=x', sessionId: 'session-1', change: 'launched', updatedAt: '2026-10-15T21:00:00.000Z' });
  assert.deepEqual(liveOf(row, 'released', at), { liveViewUrl: null, sessionId: 'session-1', change: 'released', updatedAt: '2026-10-15T21:00:00.000Z' });
  assert.equal(liveOf({ ...row, liveView: null }, 'updated', at).liveViewUrl, null);
});
